// Test doubles shared by the server tests.
import type { getStore } from '@netlify/blobs';
import type { AnalysisResult } from '../../src/core/types';

/** Minimal stand-in for an AnalysisResult: only the fields the server reads are filled. */
export function fakeAnalysis(od: number | null, tp: number | null = 0): AnalysisResult {
  const fact = (value: unknown) => ({ value, status: 'found', evidence: [] });
  return {
    engineVersion: 'test',
    analysedAt: new Date().toISOString(),
    facts: { insurer: fact('godigit'), policyType: fact('package'), premium: {} },
    result: {
      status: od == null ? 'ambiguous' : 'resolved',
      insurer: 'godigit',
      od: { ratePercent: od },
      tp: { ratePercent: tp },
    },
  } as unknown as AnalysisResult;
}

/** In-memory fake of the parts of the @netlify/blobs Store that BlobRunStore uses, with JSON round-trips like the real wire format. */
export function fakeBlobStore() {
  const entries = new Map<string, { data: ArrayBuffer; metadata: string }>();
  const enc = new TextEncoder();
  const store = {
    async set(key: string, data: Blob | ArrayBuffer | string, opts?: { metadata?: unknown }) {
      const buf = typeof data === 'string' ? enc.encode(data).buffer : data instanceof Blob ? await data.arrayBuffer() : data.slice(0);
      entries.set(key, { data: buf as ArrayBuffer, metadata: JSON.stringify(opts?.metadata ?? {}) });
      return { modified: true, etag: String(Date.now()) };
    },
    async setJSON(key: string, data: unknown, opts?: { metadata?: unknown }) {
      return store.set(key, JSON.stringify(data), opts);
    },
    async get(key: string, opts?: { type?: string }) {
      const e = entries.get(key);
      if (!e) return null;
      if (opts?.type === 'arrayBuffer') return e.data.slice(0);
      const text = new TextDecoder().decode(e.data);
      return opts?.type === 'json' ? JSON.parse(text) : text;
    },
    async getMetadata(key: string) {
      const e = entries.get(key);
      return e ? { etag: 'x', metadata: JSON.parse(e.metadata) } : null;
    },
    async delete(key: string) {
      entries.delete(key);
    },
    async list(opts?: { prefix?: string }) {
      const keys = [...entries.keys()].filter((k) => k.startsWith(opts?.prefix ?? '')).sort();
      return { blobs: keys.map((key) => ({ key, etag: 'x' })), directories: [] };
    },
  };
  return store as unknown as ReturnType<typeof getStore>;
}
