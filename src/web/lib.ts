// Browser-side helpers: API client, hashing, chunked upload/download and page-text extraction.
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { FactOverrides, PageText } from '../core/types';
import { darkenFaintText } from '../core/extract/ocr-prep';
import { CHUNK_SIZE, expectedChunkCount, type RunRecord, type RunSummary } from '../server/runs';

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  return body as T;
}
const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  list: () => call<RunSummary[]>('/api/runs'),
  get: (id: string) => call<RunRecord>(`/api/runs/${id}`),
  create: (file: File, sha256: string) =>
    call<RunRecord>('/api/runs', post({ fileName: file.name, fileSize: file.size, sha256, chunkCount: expectedChunkCount(file.size) })),
  putChunk: (id: string, index: number, data: Blob) =>
    call<RunRecord>(`/api/runs/${id}/pdf/${index}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: data }),
  pages: (id: string, pages: PageText[]) => call<RunRecord>(`/api/runs/${id}/pages`, post({ pages })),
  remove: (id: string) => call<{ deleted: string }>(`/api/runs/${id}`, { method: 'DELETE' }),
  answers: (id: string, overrides: FactOverrides) => call<RunRecord>(`/api/runs/${id}/answers`, post({ overrides })),
};

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Uploads the chunks the server does not have yet, one at a time (the API's record update is not concurrent-safe). */
export async function uploadMissingChunks(run: RunRecord, file: Blob, onProgress: (done: number, total: number) => void) {
  let current = run;
  const have = new Set(run.uploadedChunks);
  onProgress(have.size, run.chunkCount);
  for (let i = 0; i < run.chunkCount; i++) {
    if (have.has(i)) continue;
    current = await api.putChunk(run.id, i, file.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE));
    onProgress(current.uploadedChunks.length, run.chunkCount);
  }
  return current;
}

/** Downloads every stored chunk and reassembles the original PDF, checking it against the recorded sha256. */
export async function downloadPdf(run: RunRecord, onProgress?: (done: number, total: number) => void): Promise<Blob> {
  const parts: ArrayBuffer[] = [];
  for (let i = 0; i < run.chunkCount; i++) {
    const res = await fetch(`/api/runs/${run.id}/pdf/${i}`);
    if (!res.ok) throw new Error(`Chunk ${i}: ${(await res.json().catch(() => null))?.error ?? res.status}`);
    parts.push(await res.arrayBuffer());
    onProgress?.(i + 1, run.chunkCount);
  }
  const blob = new Blob(parts, { type: 'application/pdf' });
  if ((await sha256Hex(await blob.arrayBuffer())) !== run.sha256) throw new Error('Reassembled PDF does not match its sha256');
  return blob;
}

export type ExtractProgress = { page: number; pages: number; mode: 'text-layer' | 'ocr'; ocr?: number };

const MIN_TEXT_CHARS = 200;
/** Same resolution as the committed OCR fixtures (pdftoppm -r 300), so browser OCR matches what the tests cover. */
const OCR_DPI = 300;

/** Rebuilds reading lines from pdf.js text items: group by baseline y, order by x, single spaces. */
export function itemsToText(items: TextItem[]): string {
  const sorted = items
    .filter((it) => it.str.trim())
    .map((it) => ({ str: it.str.trim(), x: it.transform[4] as number, y: it.transform[5] as number, h: Math.abs(it.height) || 1 }))
    .sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: (typeof sorted)[] = [];
  for (const it of sorted) {
    const line = lines.at(-1);
    if (line && Math.abs(line[0].y - it.y) <= Math.max(2, line[0].h * 0.4)) line.push(it);
    else lines.push([it]);
  }
  return lines
    .map((l) => l.sort((a, b) => a.x - b.x).map((it) => it.str).join(' ').replace(/\s+/g, ' '))
    .join('\n');
}

/** Text layer when a page has enough of one, otherwise two OCR passes of a 300 dpi render, plain and contrast-enhanced (one tesseract worker for all pages). */
export async function extractPages(pdf: Blob, onProgress: (p: ExtractProgress) => void): Promise<PageText[]> {
  // pdf.js (~450 KB) is loaded on the first upload, not on page load.
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const task = pdfjs.getDocument({ data: new Uint8Array(await pdf.arrayBuffer()) });
  const doc = await task.promise;
  let worker: Awaited<ReturnType<typeof import('tesseract.js').createWorker>> | null = null;
  let ocrProgress: (n: number) => void = () => {};
  const out: PageText[] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const text = itemsToText(content.items.filter((it): it is TextItem => 'str' in it));
      if (text.replace(/\s/g, '').length >= MIN_TEXT_CHARS) {
        onProgress({ page: n, pages: doc.numPages, mode: 'text-layer' });
        out.push({ page: n, text, source: 'text-layer' });
        continue;
      }
      // Two OCR passes per page (plain, then contrast-enhanced), so each pass is half of the page's progress bar.
      let pass = 0;
      ocrProgress = (ocr) => onProgress({ page: n, pages: doc.numPages, mode: 'ocr', ocr: (pass + ocr) / 2 });
      ocrProgress(0);
      if (!worker) {
        const { createWorker } = await import('tesseract.js'); // loaded only when a page needs OCR
        worker = await createWorker('eng', 1, {
          logger: (m) => m.status === 'recognizing text' && ocrProgress(m.progress),
        });
      }
      const viewport = page.getViewport({ scale: OCR_DPI / 72 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvas, viewport }).promise;
      const plain = (await worker.recognize(canvas)).data;
      pass = 1;
      const ctx = canvas.getContext('2d')!;
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      darkenFaintText(img.data, 4); // faint grey de-identified fields, see ocr-prep.ts
      ctx.putImageData(img, 0, 0);
      const enhanced = (await worker.recognize(canvas)).data;
      out.push({
        page: n,
        text: plain.text,
        source: 'ocr',
        confidence: Math.round(plain.confidence),
        enhancedText: enhanced.text,
      });
      canvas.width = canvas.height = 0; // release the bitmap before the next page
      page.cleanup();
    }
  } finally {
    await worker?.terminate();
    await task.destroy();
  }
  return out;
}
