// Builds tests/fixtures/ocr/<policy>.json the way the browser OCRs a page: a 300 dpi render (pdf.js scale 300/72 there,
// pdftoppm -r 300 here) read by tesseract with English data twice - plain into `text`, then with the faint-text
// gamma from src/core/extract/ocr-prep.ts into `enhancedText`.
// Usage: npx tsx scripts/ocr-fixtures.ts [pdfDir]   (default: sample-policies/; needs poppler's pdftoppm on PATH)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorker } from 'tesseract.js';
import { darkenFaintText } from '../src/core/extract/ocr-prep';

const dir = process.argv[2] ?? 'sample-policies';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-fixtures-'));
const worker = await createWorker('eng', 1, { cachePath: tmp });

/** Binary PPM (P6) header: magic, width, height, maxval, each followed by whitespace. */
function pixelOffset(buf: Buffer): number {
  let fields = 0;
  let i = 0;
  while (fields < 4) {
    while (/\s/.test(String.fromCharCode(buf[i]))) i++;
    while (!/\s/.test(String.fromCharCode(buf[i]))) i++;
    fields++;
  }
  return i + 1;
}

try {
  for (const pdf of fs.readdirSync(dir).filter((f) => f.endsWith('.pdf')).sort()) {
    const name = pdf.replace(/\.pdf$/, '');
    execFileSync('pdftoppm', ['-r', '300', path.join(dir, pdf), path.join(tmp, name)]);
    const renders = fs.readdirSync(tmp).filter((f) => f.startsWith(`${name}-`) && f.endsWith('.ppm'))
      .map((f) => ({ file: path.join(tmp, f), page: Number(f.match(/-(\d+)\.ppm$/)![1]) }))
      .sort((a, b) => a.page - b.page);
    const out = [];
    for (const r of renders) {
      const buf = fs.readFileSync(r.file);
      const plain = (await worker.recognize(buf)).data;
      darkenFaintText(buf.subarray(pixelOffset(buf)), 3);
      const enhanced = (await worker.recognize(buf)).data;
      out.push({ page: r.page, text: plain.text, source: 'ocr', confidence: Math.round(plain.confidence), enhancedText: enhanced.text });
    }
    fs.writeFileSync(`tests/fixtures/ocr/${name}.json`, JSON.stringify(out, null, 1));
    console.log(name, out.length, 'pages');
  }
} finally {
  await worker.terminate();
  fs.rmSync(tmp, { recursive: true, force: true });
}
