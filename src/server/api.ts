// Framework-agnostic HTTP API: a Fetch `Request` in, a `Response` out. Wired to Netlify
// Functions in production and to the Vite dev server locally.
import type { analyse } from '../core/agent';
import type { AnalysisResult, FactKey, FactOverrides, PageText } from '../core/types';
import {
  CHUNK_SIZE,
  MAX_FILE_SIZE,
  RUN_ID_RE,
  chunkLength,
  expectedChunkCount,
  newRunId,
  type RunRecord,
} from './runs';
import type { RunStore } from './store';

export interface ApiDeps {
  store: RunStore;
  /** The engine's `analyse`; an async variant is accepted too. */
  analyse: (...args: Parameters<typeof analyse>) => AnalysisResult | Promise<AnalysisResult>;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

const MAX_JSON_BYTES = 5 * 1024 * 1024;
const MAX_PAGES = 500;

// Record<FactKey, true> makes the compiler flag any key added to or removed from PolicyFacts.
const FACT_KEYS: Record<FactKey, true> = {
  insurerName: true, insurer: true, policyType: true, businessType: true, previousInsurer: true,
  make: true, model: true, fuel: true, cngLpgKit: true, cc: true, seats: true, manufactureYear: true,
  registrationDate: true, vehicleAgeYears: true, registrationNumber: true, rtoCode: true,
  rtoLocation: true, state: true, ncbPercent: true, covers: true, gwpSlab: true, policyStart: true, policyEnd: true,
  'premium.netOd': true, 'premium.netTp': true, 'premium.netPremium': true, 'premium.gst': true,
  'premium.total': true,
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

async function readJson(req: Request): Promise<Record<string, unknown>> {
  if (Number(req.headers.get('content-length') ?? 0) > MAX_JSON_BYTES) throw new HttpError(413, 'Request body too large');
  const text = await req.text();
  if (text.length > MAX_JSON_BYTES) throw new HttpError(413, 'Request body too large');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Body must be valid JSON');
  }
  if (!isObject(body)) throw new HttpError(400, 'Body must be a JSON object');
  return body;
}

function parseCreate(body: Record<string, unknown>) {
  const { fileName, fileSize, sha256, chunkCount } = body;
  if (typeof fileName !== 'string' || !/\.pdf$/i.test(fileName) || fileName.length > 200 || /[\\/\u0000-\u001f]/.test(fileName))
    throw new HttpError(400, 'fileName must be a PDF file name (.pdf, at most 200 characters, no path)');
  if (!Number.isSafeInteger(fileSize) || (fileSize as number) <= 0)
    throw new HttpError(400, 'fileSize must be a positive integer');
  if ((fileSize as number) > MAX_FILE_SIZE) throw new HttpError(413, `File is larger than ${MAX_FILE_SIZE / 1024 / 1024} MB`);
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256))
    throw new HttpError(400, 'sha256 must be 64 lowercase hex characters');
  const expected = expectedChunkCount(fileSize as number);
  if (chunkCount !== expected)
    throw new HttpError(400, `chunkCount must be ${expected} for ${fileSize} bytes in ${CHUNK_SIZE}-byte chunks`);
  return { fileName, fileSize: fileSize as number, sha256, chunkCount: expected };
}

function parsePages(value: unknown): PageText[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PAGES)
    throw new HttpError(400, `pages must be a non-empty array of at most ${MAX_PAGES} pages`);
  const seen = new Set<number>();
  return value.map((p, i) => {
    if (!isObject(p)) throw new HttpError(400, `pages[${i}] must be an object`);
    const { page, text, source, confidence, enhancedText } = p;
    if (!Number.isInteger(page) || (page as number) < 1 || seen.has(page as number))
      throw new HttpError(400, `pages[${i}].page must be a unique 1-based integer`);
    seen.add(page as number);
    if (typeof text !== 'string') throw new HttpError(400, `pages[${i}].text must be a string`);
    if (source !== 'text-layer' && source !== 'ocr') throw new HttpError(400, `pages[${i}].source must be text-layer or ocr`);
    if (confidence !== undefined && (typeof confidence !== 'number' || !Number.isFinite(confidence)))
      throw new HttpError(400, `pages[${i}].confidence must be a number`);
    if (enhancedText !== undefined && typeof enhancedText !== 'string')
      throw new HttpError(400, `pages[${i}].enhancedText must be a string`);
    const out: PageText = { page: page as number, text, source };
    if (confidence !== undefined) out.confidence = confidence as number;
    // The second, contrast-enhanced OCR pass (see src/core/extract/ocr-prep.ts). Dropping it
    // here would silently disable faint-field recovery for every browser upload.
    if (enhancedText !== undefined) out.enhancedText = enhancedText;
    return out;
  });
}

function parseOverrides(value: unknown): FactOverrides {
  if (!isObject(value)) throw new HttpError(400, 'overrides must be an object keyed by fact');
  for (const [key, v] of Object.entries(value)) {
    if (!(key in FACT_KEYS)) throw new HttpError(400, `Unknown fact: ${key}`);
    const ok =
      v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 500);
    if (!ok) throw new HttpError(400, `Override for ${key} must be a string (<= 500 chars), number, boolean or null`);
  }
  return value as FactOverrides;
}

async function loadRun(store: RunStore, id: string): Promise<RunRecord> {
  if (!RUN_ID_RE.test(id)) throw new HttpError(400, 'Invalid run id');
  const run = await store.getRun(id);
  if (!run) throw new HttpError(404, 'Run not found');
  return run;
}

function parseIndex(run: RunRecord, raw: string): number {
  const index = /^\d{1,4}$/.test(raw) ? Number(raw) : -1;
  if (index < 0 || index >= run.chunkCount) throw new HttpError(400, `Chunk index must be 0..${run.chunkCount - 1}`);
  return index;
}

/** Runs the engine and appends a revision; an engine error marks the run failed instead of failing the request. */
async function runAnalysis(run: RunRecord, deps: ApiDeps): Promise<RunRecord> {
  try {
    const analysis = await deps.analyse(run.pages, run.overrides);
    run.analyses.push(analysis);
    run.status = 'analysed';
    run.error = null;
  } catch (e) {
    run.status = 'failed';
    run.error = e instanceof Error ? e.message : String(e);
  }
  run.updatedAt = new Date().toISOString();
  await deps.store.putRun(run);
  return run;
}

async function route(req: Request, deps: ApiDeps): Promise<Response> {
  const { store } = deps;
  const url = new URL(req.url);
  const m = url.pathname.match(/^\/api(\/.*)?$/);
  if (!m) throw new HttpError(404, 'Not found');
  const parts = (m[1] ?? '').split('/').filter(Boolean).map(decodeURIComponent);
  const method = req.method.toUpperCase();
  const allow = (...methods: string[]) => {
    if (!methods.includes(method)) throw new HttpError(405, `Method ${method} not allowed`);
  };

  if (parts.length === 1 && parts[0] === 'health') {
    allow('GET');
    return json({ ok: true });
  }
  if (parts[0] !== 'runs') throw new HttpError(404, 'Not found');

  // /api/runs
  if (parts.length === 1) {
    allow('GET', 'POST');
    if (method === 'GET') return json(await store.listRuns());
    const input = parseCreate(await readJson(req));
    const now = new Date().toISOString();
    const run: RunRecord = {
      id: newRunId(),
      createdAt: now,
      updatedAt: now,
      ...input,
      uploadedChunks: [],
      status: 'uploading',
      pages: [],
      overrides: {},
      analyses: [],
      error: null,
    };
    await store.putRun(run);
    return json(run, 201);
  }

  const run = await loadRun(store, parts[1]);

  // /api/runs/:id
  if (parts.length === 2) {
    allow('GET', 'DELETE');
    if (method === 'DELETE') {
      await store.deleteRun(run.id);
      return json({ deleted: run.id });
    }
    return json(run);
  }

  // /api/runs/:id/pdf/:index
  if (parts.length === 4 && parts[2] === 'pdf') {
    allow('GET', 'PUT');
    const index = parseIndex(run, parts[3]);
    if (method === 'GET') {
      const data = await store.getChunk(run.id, index);
      if (!data) throw new HttpError(404, `Chunk ${index} has not been uploaded`);
      return new Response(data as BodyInit, {
        headers: { 'content-type': 'application/octet-stream', 'cache-control': 'private, max-age=86400' },
      });
    }
    if (run.status !== 'uploading') throw new HttpError(409, 'Upload is already complete');
    const expected = chunkLength(run.fileSize, index);
    if (Number(req.headers.get('content-length') ?? 0) > CHUNK_SIZE) throw new HttpError(413, 'Chunk too large');
    const data = new Uint8Array(await req.arrayBuffer());
    if (data.byteLength !== expected)
      throw new HttpError(400, `Chunk ${index} must be exactly ${expected} bytes, got ${data.byteLength}`);
    await store.putChunk(run.id, index, data);
    // ponytail: read-modify-write on the record; the browser uploads chunks one at a time.
    // Parallel uploads would need uploadedChunks derived from the stored chunk keys instead.
    const fresh = await loadRun(store, run.id);
    fresh.uploadedChunks = [...new Set([...fresh.uploadedChunks, index])].sort((a, b) => a - b);
    if (fresh.uploadedChunks.length === fresh.chunkCount) fresh.status = 'awaiting_text';
    fresh.updatedAt = new Date().toISOString();
    await store.putRun(fresh);
    return json(fresh);
  }

  // /api/runs/:id/pages
  if (parts.length === 3 && parts[2] === 'pages') {
    allow('POST');
    if (run.status === 'uploading') throw new HttpError(409, 'Upload all PDF chunks before posting page text');
    run.pages = parsePages((await readJson(req)).pages);
    return json(await runAnalysis(run, deps));
  }

  // /api/runs/:id/answers
  if (parts.length === 3 && parts[2] === 'answers') {
    allow('POST');
    const overrides = parseOverrides((await readJson(req)).overrides);
    if (run.pages.length === 0) throw new HttpError(409, 'Run has no extracted page text yet');
    run.overrides = { ...run.overrides, ...overrides };
    return json(await runAnalysis(run, deps));
  }

  throw new HttpError(404, 'Not found');
}

export async function handleApi(req: Request, deps: ApiDeps): Promise<Response> {
  try {
    return await route(req, deps);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    if (e instanceof URIError) return json({ error: 'Malformed URL' }, 400);
    console.error('API error', e);
    return json({ error: 'Internal server error' }, 500);
  }
}
