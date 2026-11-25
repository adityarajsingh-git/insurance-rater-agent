// Persistence boundary for runs: JSON run records, compact summaries for the
// history list, and raw PDF chunks. One contract, three backends.
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { getStore } from '@netlify/blobs';
import { summarise, type RunRecord, type RunSummary } from './runs';

export interface RunStore {
  putRun(run: RunRecord): Promise<void>;
  getRun(id: string): Promise<RunRecord | null>;
  /** Newest first, without loading full records. */
  listRuns(): Promise<RunSummary[]>;
  putChunk(runId: string, index: number, data: Uint8Array): Promise<void>;
  getChunk(runId: string, index: number): Promise<Uint8Array | null>;
}

const LIST_LIMIT = 200;
const newestFirst = (a: RunSummary, b: RunSummary) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/** In-process store for tests. Clones on the way in and out, like a real backend would. */
export class MemoryRunStore implements RunStore {
  private runs = new Map<string, RunRecord>();
  private chunks = new Map<string, Uint8Array>();

  async putRun(run: RunRecord) {
    this.runs.set(run.id, structuredClone(run));
  }
  async getRun(id: string) {
    const run = this.runs.get(id);
    return run ? structuredClone(run) : null;
  }
  async listRuns() {
    return [...this.runs.values()].map(summarise).sort(newestFirst).slice(0, LIST_LIMIT);
  }
  async putChunk(runId: string, index: number, data: Uint8Array) {
    this.chunks.set(`${runId}/${index}`, data.slice());
  }
  async getChunk(runId: string, index: number) {
    return this.chunks.get(`${runId}/${index}`)?.slice() ?? null;
  }
}

/**
 * Local-dev store under `./.data/`: runs/<id>.json, runs/<id>.summary.json, chunks/<id>/<index>.bin.
 * Ids are validated by the API (lowercase alphanumerics), so they are safe as path segments.
 */
export class FsRunStore implements RunStore {
  constructor(private dir = path.resolve('.data')) {}

  private async write(file: string, data: string | Uint8Array) {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, file); // atomic: a crash never leaves a half-written record
  }
  private async read(file: string): Promise<Buffer | null> {
    try {
      return await readFile(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  async putRun(run: RunRecord) {
    const base = path.join(this.dir, 'runs', run.id);
    await this.write(`${base}.json`, JSON.stringify(run));
    await this.write(`${base}.summary.json`, JSON.stringify(summarise(run)));
  }
  async getRun(id: string) {
    const buf = await this.read(path.join(this.dir, 'runs', `${id}.json`));
    return buf ? (JSON.parse(buf.toString('utf8')) as RunRecord) : null;
  }
  async listRuns() {
    let names: string[];
    try {
      names = await readdir(path.join(this.dir, 'runs'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    const files = names.filter((n) => n.endsWith('.summary.json')).sort().reverse().slice(0, LIST_LIMIT);
    const summaries = await Promise.all(
      files.map(async (f) => JSON.parse((await readFile(path.join(this.dir, 'runs', f))).toString('utf8')) as RunSummary),
    );
    return summaries.sort(newestFirst);
  }
  async putChunk(runId: string, index: number, data: Uint8Array) {
    await this.write(path.join(this.dir, 'chunks', runId, `${index}.bin`), data);
  }
  async getChunk(runId: string, index: number) {
    const buf = await this.read(path.join(this.dir, 'chunks', runId, `${index}.bin`));
    return buf ? new Uint8Array(buf) : null;
  }
}

type BlobStore = ReturnType<typeof getStore>;

/**
 * Netlify Blobs store. Use a site-scoped named store (`getStore({ name, consistency: 'strong' })`)
 * so data survives redeploys. Each run record carries its summary as blob metadata, so the
 * history list is one `list` plus a metadata read per run instead of fetching full records.
 */
export class BlobRunStore implements RunStore {
  constructor(private blobs: BlobStore) {}

  async putRun(run: RunRecord) {
    await this.blobs.setJSON(`runs/${run.id}`, run, { metadata: { summary: summarise(run) } });
  }
  async getRun(id: string) {
    return ((await this.blobs.get(`runs/${id}`, { type: 'json' })) as RunRecord | null) ?? null;
  }
  async listRuns() {
    // ponytail: one metadata request per listed run (capped at LIST_LIMIT); switch to a single
    // index blob updated with onlyIfMatch if history grows into the thousands.
    const { blobs } = await this.blobs.list({ prefix: 'runs/' });
    const keys = blobs.map((b) => b.key).sort().reverse().slice(0, LIST_LIMIT);
    const metas = await Promise.all(keys.map((k) => this.blobs.getMetadata(k)));
    return metas
      .map((m) => m?.metadata.summary as RunSummary | undefined)
      .filter((s): s is RunSummary => !!s)
      .sort(newestFirst);
  }
  async putChunk(runId: string, index: number, data: Uint8Array) {
    await this.blobs.set(`chunks/${runId}/${index}`, new Blob([data as BlobPart]));
  }
  async getChunk(runId: string, index: number) {
    const buf = (await this.blobs.get(`chunks/${runId}/${index}`, { type: 'arrayBuffer' })) as ArrayBuffer | null;
    return buf ? new Uint8Array(buf) : null;
  }
}
