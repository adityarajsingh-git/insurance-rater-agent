// HDFC ERGO module: grid normaliser, extraction on both OCR flavours, detection, and resolution of the
// sample plus synthetic variants. Expected rates were read off the grid PDF render (page 1 rate tables,
// pages 1-2 state-to-zone table), not produced by the resolver.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { build, OUT, serialise } from '../scripts/grids/hdfc-ergo';
import { applyOverrides } from '../src/core/extract/common';
import { module } from '../src/core/insurers/hdfc-ergo';
import { SLAB_FACT } from '../src/core/insurers/hdfc-ergo/resolve';
import type { Citation, FactOverrides, PageText, RateResult } from '../src/core/types';
import grid from '../src/data/grids/hdfc-ergo.json';

const SAMPLE = 'pvt-car-comprehensive-hdfc-ergo';
const load = (dir: string, name: string): PageText[] => JSON.parse(readFileSync(`tests/fixtures/${dir}/${name}.json`, 'utf8'));
const FIXTURES = { tesseract: load('ocr', SAMPLE), vision: load('vision', SAMPLE) };
const baseFacts = module.extract(FIXTURES.tesseract);

/** Sample facts with user answers; the slab defaults to >10-50k so each case isolates one dimension. */
const run = (o: FactOverrides = {}, slab: string | null = '>10-50k'): RateResult =>
  module.resolve(applyOverrides(baseFacts, { ...(slab ? { [SLAB_FACT]: slab } : {}), ...o }));
const rates = (r: RateResult) => [r.od.ratePercent, r.tp.ratePercent];
const odCandidates = (r: RateResult) => (r.od.candidates ?? []).map((c) => c.ratePercent).sort((a, b) => a - b);
const cell = (cs: Citation[], table: string, row: string, column: string) =>
  cs.find((c) => c.table === table && c.row === row && c.column === column);

describe('grid normaliser', () => {
  it('regenerates the committed JSON byte for byte (its asserts pass)', async () => {
    expect(serialise(await build())).toBe(readFileSync(OUT, 'utf8'));
  });

  it('has 60 numeric cells and no decline markers, so the grid never declines a case', () => {
    expect(grid.rates).toHaveLength(60);
    expect(grid.rates.every((r) => /^\d+\.\d{2}%$/.test(r.raw))).toBe(true);
  });
});

describe.each(Object.entries(FIXTURES))('sample on the %s fixture', (_, pages) => {
  const facts = module.extract(pages);

  it('extracts the decisive facts with page evidence', () => {
    const expected: [keyof typeof facts, unknown, string][] = [
      ['policyType', 'package', 'PRIVATE CAR COMPREHENSIVE POLICY'],
      ['previousInsurer', 'TATA AIG GENERAL INSURANCE CO.LTD.', 'TATA AIG'],
      ['businessType', 'rollover', 'TATA AIG'],
      ['rtoCode', 'HR-26', 'HR-26'],
      ['rtoLocation', 'GURGAON', 'RTO'],
      ['state', 'Haryana', 'HR-26'],
      ['ncbPercent', 35, 'No Claim Bonus (35%)'],
      ['policyStart', '2026-03-29', '29/03/2026'],
      ['make', 'MAHINDRA', 'MAHINDRA'],
      ['model', 'BOLERO NEO-N10 (R)', 'BOLERO'],
      ['cc', 1493, '1493'],
      ['manufactureYear', 2023, '2023'],
    ];
    for (const [key, value, quote] of expected) {
      const f = facts[key] as { value: unknown; evidence: { page?: number; quote: string }[] };
      expect(f.value, key).toBe(value);
      expect(f.evidence[0].page, key).toBe(1);
      expect(f.evidence[0].quote, key).toContain(quote);
    }
    expect(facts.businessType.status).toBe('derived');
    expect(facts.fuel.status).toBe('missing'); // no fuel field anywhere in the document
    const p = facts.premium;
    expect([p.netOd.value, p.netTp.value, p.netPremium.value, p.gst.value, p.total.value]).toEqual([8053, 3816, 11869, 2136, 14005]);
    expect(p.netOd.evidence[0].quote).toContain('Net Own Damage Premium (a)');
  });

  it('is ambiguous over the five GWP slabs with a slab question (p1 Zone 2, Package)', () => {
    const r = module.resolve(facts);
    expect(r.status).toBe('ambiguous');
    // p1 Zone 2 rows <10k..>2L: Package/Petrol = Package/Non-Petrol/NCB = 15, 17.5, 20, 22, 23.
    expect(odCandidates(r)).toEqual([15, 17.5, 20, 22, 23]);
    expect((r.tp.candidates ?? []).map((c) => c.ratePercent).sort((a, b) => a - b)).toEqual([15, 17.5, 20, 22, 23]);
    expect([r.od.premiumBase, r.tp.premiumBase]).toEqual([8053, 3816]);
    expect(r.questions.map((q) => q.fact)).toEqual([SLAB_FACT]);
    expect(r.questions[0].options?.map((o) => o.value)).toEqual(grid.slabs);
    expect(r.grid?.effective).toBe('from 2025-02-01 (no end date printed)');
    expect(r.trace[0].outcome).toBe('warn'); // grid effective Feb 2025, policy Mar 2026
    expect(r.trace.find((s) => s.title === 'Look up the rate')?.detail).toContain('Unknown fuel does not change it');
  });

  it('resolves to 17.5% OD and TP once the slab is answered (p1 Zone 2 row >10-50k)', () => {
    const r = module.resolve(applyOverrides(facts, { [SLAB_FACT]: '>10-50k' }));
    expect(r.status).toBe('resolved');
    expect(rates(r)).toEqual([17.5, 17.5]);
    expect([r.od.expectedBrokerage, r.tp.expectedBrokerage]).toEqual([1409.28, 667.8]);
    expect(r.confidence.level).toBe('medium');
    const cs = r.od.citations;
    expect(cell(cs, 'State to zone mapping', 'Haryana', 'Zone-2')).toMatchObject({ page: 2, value: 'Haryana' });
    expect(cell(cs, 'Zone 2 rates', '>10-50k', 'Package / Petrol / NCB & N-NCB')).toMatchObject({ page: 1, value: '17.50%' });
    expect(cell(cs, 'Zone 2 rates', '>10-50k', 'Package / Non-Petrol / NCB')).toMatchObject({ page: 1, value: '17.50%' });
    expect(cs.find((c) => c.row === 'slab')?.value).toContain('comprehensive + SAOD GWP');
    expect(cs.every((c) => c.file === "raters/hdfc-ergo/feb-2025/Pvt Car New Grid Eff 1st Feb'25 (HDFC ergo) 1.pdf")).toBe(true);
  });
});

describe('detection', () => {
  it('recognises the HDFC ERGO sample', () => {
    expect(module.detect(FIXTURES.tesseract)?.score).toBeGreaterThanOrEqual(0.9);
  });
  it.each(['pvt-car-satp-go-digit', 'pvt-car-comprehensive-reliance', 'pvt-car-satp-tata-aig'])('ignores %s', (name) => {
    expect(module.detect(load('ocr', name))?.score ?? 0).toBeLessThan(0.3);
  });
});

describe('synthetic cases', () => {
  it('Delhi is Zone 1 (p2 Delhi/Zone-1) → 19.50% (p1 Zone 1 row >10-50k Package/Petrol)', () => {
    const r = run({ rtoCode: 'DL-3' });
    expect(rates(r)).toEqual([19.5, 19.5]);
    expect(cell(r.od.citations, 'State to zone mapping', 'Delhi', 'Zone-1')).toBeDefined();
  });

  it('Karnataka splits by place: Bengaluru → BANGALORE Zone 1 (19.50%), Mangaluru → Rest of Karnataka Zone 2 (17.50%)', () => {
    expect(rates(run({ rtoCode: 'KA-01', rtoLocation: 'Bengaluru Central' }))).toEqual([19.5, 19.5]);
    const rest = run({ rtoCode: 'KA-19', rtoLocation: 'Mangaluru' });
    expect(rates(rest)).toEqual([17.5, 17.5]);
    expect(rest.confidence.level).toBe('low'); // "Rest of" placement + package base interpretation
  });

  it('a split state without an RTO location asks for it, then resolves', () => {
    const r = run({ rtoCode: 'KA-19', rtoLocation: null });
    expect(r.status).toBe('ambiguous');
    expect(odCandidates(r)).toEqual([17.5, 19.5]); // Zone 2 vs Zone 1, row >10-50k Package/Petrol
    expect(r.questions[0]).toMatchObject({ fact: 'rtoLocation' });
    expect(rates(run({ rtoCode: 'KA-19', rtoLocation: 'BANGALORE' }))).toEqual([19.5, 19.5]);
  });

  it('a state the zone table does not list (Puducherry) is unsupported - the grid has no declines to cite', () => {
    const r = run({ rtoCode: 'PY-1' });
    expect(r.status).toBe('unsupported');
    expect(r.od.reason).toContain('no entry for Puducherry');
    expect(r.od.reason.startsWith('DECLINED')).toBe(false);
  });

  it('SATP: OD not applicable, TP unsupported (grid has Package and SAOD only)', () => {
    const r = run({ policyType: 'satp' });
    expect(r.status).toBe('unsupported');
    expect(r.od.applicability).toBe('not_applicable');
    expect(r.od.ratePercent).toBeNull();
    expect(r.tp.applicability).toBe('unsupported');
    expect(r.tp.citations.find((c) => c.row === 'slab')?.value).toContain('SATP premium is excluded');
  });

  it('N-NCB with fuel unknown asks for fuel (Petrol 17.50% vs Non-Petrol N-NCB 10.00%), then resolves on diesel', () => {
    const r = run({ ncbPercent: 0 });
    expect(r.status).toBe('ambiguous');
    expect(odCandidates(r)).toEqual([10, 17.5]);
    expect(r.questions.map((q) => q.fact)).toEqual(['fuel']);
    const answered = run({ ncbPercent: 0, fuel: 'diesel' });
    expect(answered.status).toBe('resolved');
    expect(rates(answered)).toEqual([10, 10]); // p1 Zone 2 row >10-50k Package/Non-Petrol/N-NCB
  });

  it('footnote: New Business counts as NCB - diesel, 0% NCB → 17.50% (Package/Non-Petrol/NCB), not 10.00%', () => {
    const r = run({ businessType: 'new', ncbPercent: 0, fuel: 'diesel' });
    expect(rates(r)).toEqual([17.5, 17.5]);
    expect(r.od.citations.find((c) => c.row === 'newBusiness')).toBeDefined();
  });

  it('footnote: EV uses the Petrol grid - SAOD electric N-NCB → 17.50% (SAOD/Petrol), TP not applicable', () => {
    const r = run({ policyType: 'saod', fuel: 'electric', ncbPercent: 0 });
    expect(r.od.ratePercent).toBe(17.5);
    expect(r.tp.applicability).toBe('not_applicable');
    expect(r.od.citations.find((c) => c.row === 'evHybrid')).toBeDefined();
  });

  it('footnote: a petrol car with a CNG kit is Non-Petrol - N-NCB package → 10.00%', () => {
    expect(rates(run({ fuel: 'petrol', cngLpgKit: true, ncbPercent: 0 }))).toEqual([10, 10]);
  });

  it('NCB 0% with unknown business type asks for it (NCB 17.50% vs N-NCB 10.00% for diesel)', () => {
    const r = run({ ncbPercent: 0, fuel: 'diesel', businessType: null });
    expect(odCandidates(r)).toEqual([10, 17.5]);
    expect(r.questions.map((q) => q.fact)).toEqual(['businessType']);
    expect(rates(run({ ncbPercent: 0, fuel: 'diesel', businessType: 'new' }))).toEqual([17.5, 17.5]);
  });

  it('SAOD diesel with NCB → 12.00% (p1 Zone 2 row >10-50k SAOD/Non-Petrol/NCB)', () => {
    const r = run({ policyType: 'saod', fuel: 'diesel' });
    expect(r.od).toMatchObject({ applicability: 'applicable', ratePercent: 12, premiumBase: 8053 });
    expect(r.tp.applicability).toBe('not_applicable');
  });

  it('an unknown RTO with no state asks for the RTO (Zone 1 19.50% vs Zone 2 17.50%), then resolves', () => {
    const r = run({ rtoCode: 'ZZ-99', state: null });
    expect(r.status).toBe('ambiguous');
    expect(odCandidates(r)).toEqual([17.5, 19.5]);
    expect(r.questions.map((q) => q.fact)).toEqual(['rtoCode']);
    expect(rates(run({ rtoCode: 'HR-26', state: null }))).toEqual([17.5, 17.5]);
  });

  it('a missing policy type asks for it and keeps TP ambiguous', () => {
    const r = run({ policyType: null, fuel: 'diesel' });
    expect(r.status).toBe('ambiguous');
    expect(odCandidates(r)).toEqual([12, 17.5]); // SAOD/Non-Petrol/NCB vs Package/Non-Petrol/NCB
    expect(r.tp.applicability).toBe('ambiguous');
    expect(r.questions.map((q) => q.fact)).toContain('policyType');
  });

  it('warns, without blocking, when the policy starts before the grid is effective', () => {
    const r = run({ policyStart: '2025-01-15' });
    expect(r.status).toBe('resolved');
    expect(r.trace[0]).toMatchObject({ outcome: 'warn' });
    expect(r.trace[0].detail).toContain('before');
  });
});
