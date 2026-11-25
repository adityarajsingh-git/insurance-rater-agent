// Tata AIG module tests. Every expected rate below was read from the workbook cells directly
// (openpyxl, data_only) and is cited by cell; none comes from running the resolver.
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { build, OUTPUT, render } from '../scripts/grids/tata-aig';
import { applyOverrides, missing } from '../src/core/extract/common';
import { module } from '../src/core/insurers/tata-aig';
import type { FactOverrides, PageText, PolicyFacts, RateComponent, RateResult } from '../src/core/types';

const SAMPLE = 'pvt-car-satp-tata-aig';
const pages = (dir: 'ocr' | 'vision', name = SAMPLE): PageText[] =>
  JSON.parse(readFileSync(`tests/fixtures/${dir}/${name}.json`, 'utf8'));

const cells = (c: RateComponent) => c.citations.filter((x) => x.sheet && x.cell).map((x) => `${x.sheet}!${x.cell}`);
const segmentCells = (col: string, firstRow: number) => Array.from({ length: 7 }, (_, i) => `Pvtcar!${col}${firstRow + 4 * i}`);
const rates = (c: RateComponent) => [...new Set((c.candidates ?? []).map((x) => x.ratePercent))].sort((a, b) => a - b);

const base = module.extract(pages('ocr'));
const rate = (overrides: FactOverrides = {}, facts: PolicyFacts = base): RateResult => module.resolve(applyOverrides(facts, overrides));
/** Facts with the given keys knocked out, as if the PDF never printed them. */
const without = (...keys: (keyof Omit<PolicyFacts, 'premium'>)[]): PolicyFacts => {
  const out = structuredClone(base);
  for (const k of keys) (out[k] as unknown) = missing('Removed for the test');
  return out;
};

describe.each(['ocr', 'vision'] as const)('sample %s fixture', (dir) => {
  const facts = module.extract(pages(dir));
  const result = module.resolve(facts);

  it('extracts the decisive facts with evidence', () => {
    const expected: [keyof PolicyFacts, unknown][] = [
      ['insurer', 'tata-aig'], ['policyType', 'satp'], ['businessType', 'renewal'], ['fuel', 'cng'],
      ['cngLpgKit', true], ['rtoLocation', 'DELHI'], ['policyStart', '2026-04-01'], ['policyEnd', '2027-03-31'],
      ['make', 'MARUTI'], ['model', 'ZEN ESTILO'], ['registrationDate', '2011-11-02'],
    ];
    for (const [key, value] of expected) {
      const f = facts[key] as { value: unknown; evidence: unknown[] };
      expect(f.value, key).toBe(value);
      expect(f.evidence.length, key).toBeGreaterThan(0);
    }
    expect(facts.premium.netPremium.value).toBe(2154);
    expect(facts.premium.total.value).toBe(2542);
    expect(facts.premium.gst.value).toBe(388);
    expect(facts.premium.netOd.value).toBeNull();
  });

  it('resolves TP 38% of Net Premium 2154 from DELHI V511..V535, OD not_applicable', () => {
    expect(result.status).toBe('resolved');
    expect(result.od.applicability).toBe('not_applicable');
    expect(result.od.ratePercent).toBeNull();
    expect(result.tp.applicability).toBe('applicable');
    expect(result.tp.ratePercent).toBeCloseTo(38);
    expect(result.tp.premiumBase).toBe(2154);
    expect(result.tp.expectedBrokerage).toBeCloseTo(818.52, 2);
    expect(cells(result.tp)).toEqual(expect.arrayContaining([
      ...segmentCells('V', 511), 'Pvtcar!V5', 'Pvtcar!F2', 'General Guidelines!C7',
    ]));
    for (const c of result.tp.citations.filter((x) => /^V5\d\d$/.test(x.cell ?? ''))) expect(c.value).toBe(0.38);
    expect(result.grid?.effective).toMatch(/2025-11-01/);
  });

  it('says in the trace that the unknown segment is moot because all seven cells agree', () => {
    const step = result.trace.find((t) => t.title === 'TP rate');
    expect(step?.detail).toMatch(/all 7 candidate cells agree/);
    expect(result.trace.find((t) => t.title === 'Dimension: segment')?.detail).toMatch(/unknown/);
  });
});

describe('extraction gaps on the tesseract fixture', () => {
  it('falls back to RTO Location and Fuel Type when tesseract drops "DL 9C AB 2893"', () => {
    expect(base.registrationNumber.status).toBe('missing');
    expect(base.rtoLocation.evidence[0]).toMatchObject({ page: 4 });
    expect(base.fuel.evidence.map((e) => e.page)).toContain(11);
    expect(module.extract(pages('vision')).rtoCode.value).toBe('DL-9');
  });
});

describe('detection', () => {
  it('is positive on the sample and null on the other insurers', () => {
    expect(module.detect(pages('ocr'))?.score).toBeGreaterThanOrEqual(0.8);
    for (const f of readdirSync('tests/fixtures/ocr').filter((f) => !f.startsWith(SAMPLE))) {
      const d = module.detect(pages('ocr', f.replace(/\.json$/, '')));
      expect(d === null || d.score < 0.3, f).toBe(true);
    }
  });
});

describe('synthetic cases', () => {
  it('Himachal Pradesh (state column Y) gives Y511..Y535 = 0.365', () => {
    const r = rate({ rtoCode: 'HP-01', rtoLocation: 'SHIMLA', state: 'Himachal Pradesh' });
    expect(r.status).toBe('resolved');
    expect(r.tp.ratePercent).toBeCloseTo(36.5);
    expect(r.tp.expectedBrokerage).toBeCloseTo(786.21, 2);
    expect(cells(r.tp)).toEqual(expect.arrayContaining(segmentCells('Y', 511)));
  });

  it('Rollover Diesel SATP in MUMBAI hits another row: AL538..AL562 = 0.35, OD not_applicable', () => {
    const r = rate({ businessType: 'rollover', fuel: 'diesel', cngLpgKit: false, rtoLocation: 'MUMBAI', rtoCode: 'MH-01', state: 'Maharashtra' });
    expect(r.status).toBe('resolved');
    expect(r.od.applicability).toBe('not_applicable');
    expect(r.tp.ratePercent).toBeCloseTo(35);
    expect(r.tp.expectedBrokerage).toBeCloseTo(753.9, 2);
    expect(cells(r.tp)).toEqual(expect.arrayContaining(segmentCells('AL', 538)));
  });

  it('HARYANA is declined: X511..X535 = 0 -> unsupported DECLINED', () => {
    const r = rate({ rtoCode: 'HR-26', rtoLocation: 'GURGAON', state: 'Haryana' });
    expect(r.status).toBe('unsupported');
    expect(r.tp.applicability).toBe('unsupported');
    expect(r.tp.reason).toMatch(/^DECLINED/);
    expect(cells(r.tp)).toEqual(expect.arrayContaining(segmentCells('X', 511)));
  });

  it('Brand New + SAOD is a combination the grid has no rows for -> unsupported', () => {
    const r = rate({ businessType: 'new', policyType: 'saod', 'premium.netOd': 5000 });
    expect(r.status).toBe('unsupported');
    expect(r.od.applicability).toBe('unsupported');
    expect(r.od.reason).toMatch(/Brand New \+ SAOD/);
  });

  it('missing fuel is decisive in DELHI (Diesel V510 = 0.19 vs CNG V511 = 0.38) -> ambiguous, then answered', () => {
    const facts = without('fuel', 'cngLpgKit');
    const r = module.resolve(facts);
    expect(r.status).toBe('ambiguous');
    expect(r.tp.applicability).toBe('ambiguous');
    expect(rates(r.tp)).toEqual([19, 38]);
    expect(r.questions.map((q) => q.fact)).toContain('fuel');

    const answered = rate({ fuel: 'cng' }, facts);
    expect(answered.status).toBe('resolved');
    expect(answered.tp.ratePercent).toBeCloseTo(38);
  });

  it('Maharashtra outside the city columns maps to clusters ROM1..ROM4 (0.25 / 0.2) -> ambiguous, then answered', () => {
    const r = rate({ rtoCode: 'MH-04', rtoLocation: 'THANE', state: 'Maharashtra' });
    expect(r.status).toBe('ambiguous');
    expect(rates(r.tp)).toEqual([20, 25]); // AY511/AZ511 = 0.25, BA511/BB511 = 0.2
    const q = r.questions.find((x) => x.fact === 'rtoLocation');
    expect(q?.options?.map((o) => o.value)).toEqual(['ROM1', 'ROM2', 'ROM3', 'ROM4']);

    const answered = rate({ rtoCode: 'MH-04', rtoLocation: 'ROM3', state: 'Maharashtra' });
    expect(answered.status).toBe('resolved');
    expect(answered.tp.ratePercent).toBeCloseTo(20);
    expect(cells(answered.tp)).toEqual(expect.arrayContaining(segmentCells('BA', 511)));
  });

  it('Punjab clusters PB1 and PB2 agree (AN511..AN535 = AO511..AO535 = 0.42) -> resolved', () => {
    const r = rate({ rtoCode: 'PB-10', rtoLocation: 'LUDHIANA', state: 'Punjab' });
    expect(r.status).toBe('resolved');
    expect(r.tp.ratePercent).toBeCloseTo(42);
    expect(cells(r.tp)).toEqual(expect.arrayContaining([...segmentCells('AN', 511), ...segmentCells('AO', 511)]));
  });

  it('long-term TP is excluded by General Guidelines!C9 ("LTTP not be considered ... payout %") -> unsupported', () => {
    const r = rate({ policyEnd: '2029-03-31' });
    expect(r.status).toBe('unsupported');
    expect(r.tp.reason).toMatch(/LTTP/);
    expect(cells(r.tp)).toContain('General Guidelines!C9');
  });

  it('a policy before the grid start (Pvtcar!F1: from 1st Nov 25) still resolves with a warn step', () => {
    const r = rate({ policyStart: '2025-06-01', policyEnd: '2026-05-31' });
    expect(r.status).toBe('resolved');
    expect(r.tp.ratePercent).toBeCloseTo(38);
    expect(r.trace.find((t) => t.title === 'Grid validity')?.outcome).toBe('warn');
  });

  it('Package pays on OD premium only (Pvtcar!F2): Renewal petrol Compact DELHI V86..V89 = 0.195', () => {
    const r = rate({ policyType: 'package', fuel: 'petrol', cngLpgKit: false, model: 'Compact', 'premium.netOd': 5000 });
    expect(r.status).toBe('resolved');
    expect(r.od.ratePercent).toBeCloseTo(19.5);
    expect(r.od.premiumBase).toBe(5000);
    expect(r.od.expectedBrokerage).toBeCloseTo(975, 2);
    expect(r.tp.applicability).toBe('not_applicable');
    expect(cells(r.od)).toEqual(expect.arrayContaining(['Pvtcar!V86', 'Pvtcar!V87', 'Pvtcar!V88', 'Pvtcar!V89']));
  });

  it('an unknown RTO code matches no column and no state -> unsupported', () => {
    const r = rate({ rtoCode: 'ZZ-01' }, without('rtoLocation', 'state'));
    expect(r.status).toBe('unsupported');
    expect(r.tp.reason).toMatch(/No location column reachable/);
  });
});

describe('grid build', () => {
  it('re-runs the build asserts and regenerates the committed JSON byte for byte', () => {
    expect(render(build())).toBe(readFileSync(OUTPUT, 'utf8'));
  });
});
