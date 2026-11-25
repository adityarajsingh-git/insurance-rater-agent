// Agent pipeline on the committed Tesseract fixtures: the plain OCR pass drives extraction, and the
// contrast-enhanced pass only fills facts the plain pass left missing (src/core/agent.ts).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyse } from '../src/core/agent';
import type { AnalysisResult, PageText } from '../src/core/types';

const load = (name: string): PageText[] => JSON.parse(readFileSync(`tests/fixtures/ocr/${name}.json`, 'utf8'));
const plainOnly = (pages: PageText[]): PageText[] => pages.map(({ enhancedText: _, ...p }) => p);
const recovered = (r: AnalysisResult) => r.result.trace.find((s) => s.title === 'Recover faint fields');

describe('contrast-enhanced OCR recovery', () => {
  it('HDFC Ergo: a plain-pass misread ("FB8") is replaced by the enhanced read; the plain-pass RTO stays', () => {
    const r = analyse(load('pvt-car-comprehensive-hdfc-ergo'));
    expect(r.facts.registrationNumber.value).toBe('HR-26-FB-8239');
    expect(r.facts.registrationNumber.note).toContain('contrast-enhanced');
    expect(r.facts.rtoCode.value).toBe('HR-26');
    expect(r.facts.rtoCode.note ?? '').not.toContain('contrast-enhanced');
    expect(recovered(r)?.detail).toContain('registrationNumber');
  });

  it('HDFC Ergo without the enhanced pass: the misread mark is left missing, the RTO still resolves', () => {
    const r = analyse(plainOnly(load('pvt-car-comprehensive-hdfc-ergo')));
    expect(r.facts.registrationNumber.status).toBe('missing');
    expect(r.facts.registrationNumber.note).toContain('HR-26-FB8-8239');
    expect(r.facts.rtoCode.value).toBe('HR-26');
    expect(recovered(r)).toBeUndefined();
  });

  it('Go Digit, as the browser render reads it: the plain pass drops the faint mark, the enhanced pass supplies it', () => {
    // pdf.js renders the de-identified fields fainter than pdftoppm does; emulate that by blanking the mark in the
    // plain text and keeping the committed text as the enhanced read.
    const pages = load('pvt-car-satp-go-digit').map((p) => ({ ...p, enhancedText: p.text, text: p.text.replace(/UP78FZ1372/g, '') }));
    const r = analyse(pages);
    expect(r.facts.registrationNumber.value).toBe('UP78FZ1372');
    expect(r.facts.registrationNumber.note).toContain('contrast-enhanced');
    expect(r.facts.rtoCode.value).toBe('UP-78');
    expect(r.result.status).toBe('resolved');
    expect([r.result.od.applicability, r.result.tp.ratePercent]).toEqual(['not_applicable', 29.5]);
  });

  it('never overrides a fact the plain pass found: every sample gives the same facts and rates either way', () => {
    for (const name of ['pvt-car-satp-go-digit', 'pvt-car-comprehensive-reliance', 'pvt-car-satp-tata-aig']) {
      const withEnhanced = analyse(load(name));
      const plain = analyse(plainOnly(load(name)));
      expect(recovered(withEnhanced), name).toBeUndefined();
      expect(withEnhanced.facts, name).toEqual(plain.facts);
      expect(withEnhanced.result.od, name).toEqual(plain.result.od);
      expect(withEnhanced.result.tp, name).toEqual(plain.result.tp);
    }
  });
});
