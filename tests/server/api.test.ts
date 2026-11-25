import { createHash, randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { analyse } from '../../src/core/agent';
import type { PageText } from '../../src/core/types';
import { handleApi } from '../../src/server/api';
import { CHUNK_SIZE, type RunRecord } from '../../src/server/runs';
import { MemoryRunStore } from '../../src/server/store';
import { fakeAnalysis } from './fakes';

vi.mock('../../src/core/agent', () => ({ ENGINE_VERSION: 'test', analyse: vi.fn() }));
const mockAnalyse = vi.mocked(analyse);

let store: MemoryRunStore;
beforeEach(() => {
  store = new MemoryRunStore();
  mockAnalyse.mockReset();
});

async function call(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method };
  if (body instanceof Uint8Array) init.body = body as BodyInit;
  else if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  const res = await handleApi(new Request(`http://localhost${path}`, init), { store, analyse });
  const isJson = res.headers.get('content-type')?.includes('json');
  return { status: res.status, body: isJson ? await res.json() : new Uint8Array(await res.arrayBuffer()) };
}

const PDF = randomBytes(2 * CHUNK_SIZE + 1234); // three chunks, the last one short
const SHA = createHash('sha256').update(PDF).digest('hex');
const chunk = (i: number) => new Uint8Array(PDF.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE));
const PAGES: PageText[] = [
  { page: 1, text: 'Policy schedule HR-26', source: 'text-layer' },
  // enhancedText is the contrast-enhanced OCR pass; it must survive the API round trip.
  { page: 2, text: 'scanned', source: 'ocr', confidence: 88, enhancedText: 'scanned UP78FZ1372' },
];

async function createRun(): Promise<RunRecord> {
  const res = await call('POST', '/api/runs', { fileName: 'policy.pdf', fileSize: PDF.length, sha256: SHA, chunkCount: 3 });
  expect(res.status).toBe(201);
  return res.body as RunRecord;
}
async function uploadAll(id: string) {
  for (const i of [2, 0, 1]) expect((await call('PUT', `/api/runs/${id}/pdf/${i}`, chunk(i))).status).toBe(200);
}

describe('API happy path', () => {
  it('health', async () => {
    expect(await call('GET', '/api/health')).toEqual({ status: 200, body: { ok: true } });
  });

  it('create -> out-of-order chunks -> identical bytes -> pages -> answers', async () => {
    const run = await createRun();
    expect(run).toMatchObject({ status: 'uploading', chunkCount: 3, uploadedChunks: [], analyses: [] });

    const after2 = await call('PUT', `/api/runs/${run.id}/pdf/2`, chunk(2));
    expect(after2.body).toMatchObject({ uploadedChunks: [2], status: 'uploading' });
    await call('PUT', `/api/runs/${run.id}/pdf/0`, chunk(0));
    // Re-sending a chunk while uploading is idempotent.
    await call('PUT', `/api/runs/${run.id}/pdf/0`, chunk(0));
    const done = await call('PUT', `/api/runs/${run.id}/pdf/1`, chunk(1));
    expect(done.body).toMatchObject({ uploadedChunks: [0, 1, 2], status: 'awaiting_text' });

    const parts = await Promise.all([0, 1, 2].map((i) => call('GET', `/api/runs/${run.id}/pdf/${i}`)));
    const rebuilt = Buffer.concat(parts.map((p) => p.body as Uint8Array));
    expect(rebuilt.equals(PDF)).toBe(true);
    expect(createHash('sha256').update(rebuilt).digest('hex')).toBe(SHA);

    mockAnalyse.mockReturnValueOnce(fakeAnalysis(null));
    const analysed = await call('POST', `/api/runs/${run.id}/pages`, { pages: PAGES });
    expect(analysed.status).toBe(200);
    expect(analysed.body).toMatchObject({ status: 'analysed', pages: PAGES, error: null });
    expect((analysed.body as RunRecord).analyses).toHaveLength(1);
    expect(mockAnalyse).toHaveBeenLastCalledWith(PAGES, {});

    mockAnalyse.mockReturnValueOnce(fakeAnalysis(17.5, 2.5));
    const answered = await call('POST', `/api/runs/${run.id}/answers`, { overrides: { cc: 1197, fuel: 'petrol' } });
    expect(answered.status).toBe(200);
    expect(mockAnalyse).toHaveBeenLastCalledWith(PAGES, { cc: 1197, fuel: 'petrol' });
    mockAnalyse.mockReturnValueOnce(fakeAnalysis(17.5, 2.5));
    const again = await call('POST', `/api/runs/${run.id}/answers`, { overrides: { fuel: 'diesel' } });
    expect((again.body as RunRecord).overrides).toEqual({ cc: 1197, fuel: 'diesel' });
    expect((again.body as RunRecord).analyses.map((a) => a.result.od.ratePercent)).toEqual([null, 17.5, 17.5]);

    const full = await call('GET', `/api/runs/${run.id}`);
    expect((full.body as RunRecord).analyses).toHaveLength(3);
  });

  it('lists summaries newest first', async () => {
    const a = await createRun();
    await new Promise((r) => setTimeout(r, 5));
    const b = await createRun();
    await uploadAll(b.id);
    mockAnalyse.mockReturnValueOnce(fakeAnalysis(17.5, 2.5));
    await call('POST', `/api/runs/${b.id}/pages`, { pages: PAGES });
    const list = await call('GET', '/api/runs');
    expect(list.body).toMatchObject([
      { id: b.id, status: 'analysed', insurer: 'godigit', resultStatus: 'resolved', odRate: 17.5, tpRate: 2.5 },
      { id: a.id, status: 'uploading', odRate: null },
    ]);
  });

  it('keeps an engine error in the record as failed, and a retry recovers', async () => {
    const run = await createRun();
    await uploadAll(run.id);
    mockAnalyse.mockImplementationOnce(() => {
      throw new Error('grid not found');
    });
    const failed = await call('POST', `/api/runs/${run.id}/pages`, { pages: PAGES });
    expect(failed.status).toBe(200);
    expect(failed.body).toMatchObject({ status: 'failed', error: 'grid not found', analyses: [] });
    mockAnalyse.mockReturnValueOnce(fakeAnalysis(10));
    const retried = await call('POST', `/api/runs/${run.id}/answers`, { overrides: {} });
    expect(retried.body).toMatchObject({ status: 'analysed', error: null });
  });
});

describe('API validation', () => {
  const create = (over: Record<string, unknown>) =>
    call('POST', '/api/runs', { fileName: 'policy.pdf', fileSize: PDF.length, sha256: SHA, chunkCount: 3, ...over });

  it.each([
    ['non-PDF name', { fileName: 'policy.docx' }, 400],
    ['path in name', { fileName: '../x.pdf' }, 400],
    ['zero size', { fileSize: 0 }, 400],
    ['oversize', { fileSize: 25 * 1024 * 1024 + 1, chunkCount: 11 }, 413],
    ['inconsistent chunkCount', { chunkCount: 2 }, 400],
    ['bad sha256', { sha256: 'xyz' }, 400],
  ])('rejects %s', async (_, over, status) => {
    const res = await create(over);
    expect(res.status).toBe(status);
    expect(res.body).toHaveProperty('error');
  });

  it('rejects malformed JSON and non-object bodies', async () => {
    expect((await call('POST', '/api/runs', '{nope')).status).toBe(400);
    expect((await call('POST', '/api/runs', '[1]')).status).toBe(400);
  });

  it('rejects bad and unknown run ids', async () => {
    expect((await call('GET', '/api/runs/BAD!id')).status).toBe(400);
    expect((await call('GET', '/api/runs/%E0%A4%A')).status).toBe(400);
    expect((await call('GET', '/api/runs/0000000000000')).status).toBe(404);
  });

  it('rejects wrong chunk index, wrong chunk size, and uploads after completion', async () => {
    const run = await createRun();
    expect((await call('PUT', `/api/runs/${run.id}/pdf/3`, chunk(0))).status).toBe(400);
    expect((await call('PUT', `/api/runs/${run.id}/pdf/-1`, chunk(0))).status).toBe(400);
    expect((await call('PUT', `/api/runs/${run.id}/pdf/abc`, chunk(0))).status).toBe(400);
    expect((await call('PUT', `/api/runs/${run.id}/pdf/2`, chunk(0))).status).toBe(400); // last chunk is short
    expect((await call('PUT', `/api/runs/${run.id}/pdf/0`, new Uint8Array(CHUNK_SIZE + 1))).status).toBe(400);
    expect((await call('GET', `/api/runs/${run.id}/pdf/0`)).status).toBe(404); // not uploaded yet
    await uploadAll(run.id);
    expect((await call('PUT', `/api/runs/${run.id}/pdf/0`, chunk(0))).status).toBe(409);
  });

  it('rejects page text before the upload completes, and malformed pages', async () => {
    const run = await createRun();
    expect((await call('POST', `/api/runs/${run.id}/pages`, { pages: PAGES })).status).toBe(409);
    await uploadAll(run.id);
    for (const pages of [[], 'x', [{ page: 0, text: '', source: 'ocr' }], [{ page: 1, text: 1, source: 'ocr' }], [{ page: 1, text: '', source: 'scan' }], [{ page: 1, text: '', source: 'ocr', enhancedText: 7 }], [PAGES[0], PAGES[0]]])
      expect((await call('POST', `/api/runs/${run.id}/pages`, { pages })).status).toBe(400);
    expect(mockAnalyse).not.toHaveBeenCalled();
  });

  it('rejects answers with unknown facts or bad values, and answers before any page text', async () => {
    const run = await createRun();
    expect((await call('POST', `/api/runs/${run.id}/answers`, { overrides: { cc: 1197 } })).status).toBe(409);
    expect((await call('POST', `/api/runs/${run.id}/answers`, { overrides: { colour: 'red' } })).status).toBe(400);
    expect((await call('POST', `/api/runs/${run.id}/answers`, { overrides: { cc: { a: 1 } } })).status).toBe(400);
    expect((await call('POST', `/api/runs/${run.id}/answers`, { overrides: 'x' })).status).toBe(400);
  });

  it('returns 404 for unknown routes and 405 for wrong methods', async () => {
    expect((await call('GET', '/api/nope')).status).toBe(404);
    expect((await call('GET', '/elsewhere')).status).toBe(404);
    expect((await call('DELETE', '/api/runs')).status).toBe(405);
    const run = await createRun();
    expect((await call('GET', `/api/runs/${run.id}/pages`)).status).toBe(405);
  });
});
