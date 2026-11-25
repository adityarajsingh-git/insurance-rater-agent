import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { newRunId, type RunRecord } from '../../src/server/runs';
import { BlobRunStore, FsRunStore, MemoryRunStore, type RunStore } from '../../src/server/store';
import { fakeAnalysis, fakeBlobStore } from './fakes';

function record(id: string, over: Partial<RunRecord> = {}): RunRecord {
  const now = new Date().toISOString();
  return {
    id, createdAt: now, updatedAt: now, fileName: `${id}.pdf`, fileSize: 10, sha256: 'a'.repeat(64),
    chunkCount: 1, uploadedChunks: [], status: 'uploading', pages: [], overrides: {}, analyses: [], error: null, ...over,
  };
}

const tempDirs: string[] = [];
afterAll(() => Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true }))));
async function tempDir() {
  const d = await mkdtemp(path.join(tmpdir(), 'rater-store-'));
  tempDirs.push(d);
  return d;
}

function contract(name: string, make: () => Promise<RunStore>) {
  describe(`${name} contract`, () => {
    it('returns null for unknown runs and chunks', async () => {
      const s = await make();
      expect(await s.getRun('zzzzzzzzzzzz')).toBeNull();
      expect(await s.getChunk('zzzzzzzzzzzz', 0)).toBeNull();
      expect(await s.listRuns()).toEqual([]);
    });

    it('round-trips a run record and overwrites on put', async () => {
      const s = await make();
      const r = record(newRunId());
      await s.putRun(r);
      expect(await s.getRun(r.id)).toEqual(r);
      const updated = { ...r, status: 'analysed' as const, analyses: [fakeAnalysis(17.5, 0)], overrides: { cc: 1197 } };
      await s.putRun(updated);
      expect(await s.getRun(r.id)).toEqual(updated);
    });

    it('lists summaries newest first, reflecting the latest analysis', async () => {
      const s = await make();
      const older = record(newRunId(Date.now() - 60_000));
      const newer = record(newRunId(), { status: 'analysed', analyses: [fakeAnalysis(12), fakeAnalysis(17.5, 2.5)] });
      await s.putRun(older);
      await s.putRun(newer);
      const list = await s.listRuns();
      expect(list.map((x) => x.id)).toEqual([newer.id, older.id]);
      expect(list[0]).toMatchObject({ status: 'analysed', insurer: 'godigit', policyType: 'package', resultStatus: 'resolved', odRate: 17.5, tpRate: 2.5 });
      expect(list[1]).toMatchObject({ status: 'uploading', insurer: null, odRate: null });
      expect(list[0]).not.toHaveProperty('pages');
    });

    it('stores binary chunks byte-for-byte per (run, index)', async () => {
      const s = await make();
      const a = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7) % 256);
      const b = Uint8Array.from([0, 255, 1, 254]);
      await s.putChunk('run1aaaaaaaa', 0, a);
      await s.putChunk('run1aaaaaaaa', 1, b);
      expect(await s.getChunk('run1aaaaaaaa', 0)).toEqual(a);
      expect(await s.getChunk('run1aaaaaaaa', 1)).toEqual(b);
      expect(await s.getChunk('run2aaaaaaaa', 0)).toBeNull();
    });
  });
}

contract('MemoryRunStore', async () => new MemoryRunStore());
contract('FsRunStore', async () => new FsRunStore(await tempDir()));
contract('BlobRunStore (fake blobs)', async () => new BlobRunStore(fakeBlobStore()));

describe('FsRunStore persistence', () => {
  it('a second instance on the same directory sees everything (restart)', async () => {
    const dir = await tempDir();
    const r = record(newRunId(), { status: 'analysed', analyses: [fakeAnalysis(15)] });
    const first = new FsRunStore(dir);
    await first.putRun(r);
    await first.putChunk(r.id, 0, Uint8Array.from([1, 2, 3]));

    const second = new FsRunStore(dir);
    expect(await second.getRun(r.id)).toEqual(r);
    expect(await second.getChunk(r.id, 0)).toEqual(Uint8Array.from([1, 2, 3]));
    expect((await second.listRuns())[0]).toMatchObject({ id: r.id, odRate: 15 });
  });
});
