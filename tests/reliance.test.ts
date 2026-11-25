// Reliance General module: grid build, extraction on both OCR flavours, the sample answer, and
// synthetic cases. Expected rates are read from the workbook cells named in each test, not from
// the resolver: PC = 'PRIVATE CAR COMP, SAOD & STP', MAIN = 'FEB''26 - Grid'.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import XLSX from 'xlsx';
import { build, render, OUTPUT, SOURCE } from '../scripts/grids/reliance';
import { applyOverrides, flat, found, missing } from '../src/core/extract/common';
import { module } from '../src/core/insurers/reliance';
import type { RelianceFacts } from '../src/core/insurers/reliance/extract';
import type { FactOverrides, PageText, RateComponent, RateResult } from '../src/core/types';

const load = (kind: string, name: string): PageText[] => JSON.parse(readFileSync(`tests/fixtures/${kind}/${name}.json`, 'utf8'));
const SAMPLE = 'pvt-car-comprehensive-reliance';
const sample = load('ocr', SAMPLE);
const base = module.extract(sample) as RelianceFacts;
const run = (overrides: FactOverrides = {}, edit: Partial<RelianceFacts> = {}): RateResult =>
  module.resolve(applyOverrides({ ...base, ...edit }, overrides));
const cells = (c: RateComponent) => c.citations.map((x) => `${x.sheet}!${x.cell}`);
const PC = 'PRIVATE CAR COMP, SAOD & STP';
const MAIN = "FEB'26 - Grid";
const candidateRates = (c: RateComponent) => (c.candidates ?? []).map((x) => x.ratePercent).sort((a, b) => a - b);

describe('grid build', () => {
  it('regenerates the committed JSON (all structural asserts pass)', () => {
    expect(render(build())).toBe(readFileSync(OUTPUT, 'utf8'));
  });

  it('decisive cells in the JSON match the workbook read independently', () => {
    const wb = XLSX.read(readFileSync(SOURCE));
    const v = (sheet: string, cell: string) => wb.Sheets[sheet][cell]?.v;
    expect(v(PC, 'C11')).toBe(22.5);
    expect(v(PC, 'D11')).toBe(10);
    expect(v(PC, 'F11')).toBe(0);
    expect(v(PC, 'H3')).toBe('Payout for < 1000 CC, PO will be 5% lesser than the above Grid');
    expect(v(PC, 'H2')).toBe('payout will made on OD Premium');
    expect([v('RTO List', 'A1253'), v('RTO List', 'C1253')]).toEqual(['UP-16', 'Delhi']);
    expect([v(MAIN, 'C41'), v(MAIN, 'AR41')]).toEqual(['DELHI', 0]);
  });
});

describe.each(['ocr', 'vision'])('sample policy (%s fixture)', (kind) => {
  const pages = load(kind, SAMPLE);
  const facts = module.extract(pages) as RelianceFacts;

  it('detects Reliance', () => {
    expect(module.detect(pages)?.score).toBeGreaterThanOrEqual(0.5);
  });

  it('extracts the key facts with page evidence', () => {
    expect(facts.insurer.value).toBe('reliance');
    expect(facts.policyType.value).toBe('package');
    expect(facts.previousInsurer.value).toMatch(/Reliance General/);
    expect(facts.businessType).toMatchObject({ value: 'renewal', status: 'derived' });
    expect(facts.registrationNumber.value).toBe('UP16CS5830');
    expect(facts.rtoCode.value).toBe('UP-16');
    expect(facts.cc.value).toBe(999);
    expect(facts.fuel).toMatchObject({ value: 'petrol', status: 'derived' });
    expect(facts.make.value).toBe('RENAULT');
    expect(facts.model.value).toBe('KWID 1.0 RXT O');
    expect(facts.ncbPercent.value).toBe(25);
    expect(facts.policyStart.value).toBe('2025-12-23');
    expect(facts.policyEnd.value).toBe('2026-12-22');
    expect(facts.registrationDate.value).toBe('2020-12-24');
    expect(facts.vehicleAgeYears.value).toBe(4);
    expect(facts.premium.netOd.value).toBe(4714);
    expect(facts.premium.netTp.value).toBe(2094);
    expect(facts.premium.netPremium.value).toBe(7233);
    expect(facts.premium.gst.value).toBe(1302);
    expect(facts.premium.total.value).toBe(8535);
    expect(facts.covers?.value).toEqual(expect.arrayContaining(['Nil Depreciation', 'Compulsory PA cover to Owner Driver']));
    expect(facts.covers?.value?.some((c) => /tyre|invoice/i.test(c))).toBe(false);

    const all = [...Object.entries(facts).filter(([k]) => k !== 'premium'), ...Object.entries(facts.premium)];
    for (const [key, fact] of all) {
      if (fact.status !== 'found' && fact.status !== 'derived') continue;
      expect(fact.evidence.length, key).toBeGreaterThan(0);
      for (const e of fact.evidence) {
        const page = pages.find((p) => p.page === e.page);
        expect(page && flat(page).includes(e.quote), `${key}: "${e.quote}"`).toBe(true);
      }
    }
  });

  it('resolves OD 17.5% (PC!C11 22.5 - 5 points by PC!H3) and TP 0% (PC!H2)', () => {
    const r = module.resolve(facts);
    expect(r.status).toBe('resolved');
    expect(r.od).toMatchObject({ applicability: 'applicable', ratePercent: 17.5, premiumBase: 4714, expectedBrokerage: 824.95 });
    expect(r.tp).toMatchObject({ applicability: 'applicable', ratePercent: 0, premiumBase: 2094, expectedBrokerage: 0 });
    expect(cells(r.od)).toEqual(expect.arrayContaining([`${PC}!C11`, `${PC}!H3`, 'RTO List!A1253', `${PC}!B11`]));
    expect(cells(r.tp)).toEqual(expect.arrayContaining([`${PC}!H2`, `${PC}!F11`, `${MAIN}!AR41`]));
    expect(r.confidence.level).toBe('medium');
    expect(r.grid?.effective).toMatch(/2026-02-01 to 2026-02-28/);
    expect(r.trace.find((t) => t.title === 'Grid effective period')?.outcome).toBe('warn');
    expect(r.trace.find((t) => t.title.startsWith('Cubic capacity'))?.detail).toMatch(/percentage points/);
    expect(r.questions).toEqual([]);
  });
});

describe('detection on other insurers', () => {
  it.each(['pvt-car-comprehensive-hdfc-ergo', 'pvt-car-satp-go-digit', 'pvt-car-satp-tata-aig'])('%s', (name) => {
    const d = module.detect(load('ocr', name));
    expect(d === null || d.score < 0.3).toBe(true);
  });
});

describe('synthetic cases', () => {
  it('another geography: MH-12 is Pune -> PC row 3, C3 25 - 5 = 20%', () => {
    const r = run({ registrationNumber: 'MH12AB1234' });
    expect(r.od.ratePercent).toBe(20);
    expect(cells(r.od)).toEqual(expect.arrayContaining(['RTO List!A697', `${PC}!C3`]));
  });

  it('UP-15 (Up2) takes row 13 "UP, Haryana , Rajasthan": C13 12.5 - 5 = 7.5%, unlike NCR UP-16', () => {
    expect(run({ rtoCode: 'UP-15' }).od.ratePercent).toBe(7.5);
  });

  it('new business -> unsupported: PC!A1 is an Old Business grid (the workbook publishes no declined cells)', () => {
    const r = run({ businessType: 'new' });
    expect(r.status).toBe('unsupported');
    expect(r.od.applicability).toBe('unsupported');
    expect(r.od.reason).toMatch(/Old Business/);
    expect(cells(r.od)).toContain(`${PC}!A1`);
  });

  it('missing fuel -> ambiguous: C11 22.5 - 5 = 17.5% vs D11 10 - 5 = 5%, with a fuel question', () => {
    const r = run({}, { fuel: missing('Fuel type is not printed') });
    expect(r.status).toBe('ambiguous');
    expect(candidateRates(r.od)).toEqual([5, 17.5]);
    expect(r.od.candidates?.find((c) => c.ratePercent === 17.5)?.assumption).toMatch(/percentage points/);
    expect(r.tp).toMatchObject({ applicability: 'applicable', ratePercent: 0 });
    expect(r.questions.map((q) => q.fact)).toEqual(['fuel']);
  });

  it('answering the fuel question resolves: petrol 17.5% (C11), diesel 5% (D11 10 - 5)', () => {
    const noFuel = { ...base, fuel: missing<never>('Fuel type is not printed') };
    expect(module.resolve(applyOverrides(noFuel, { fuel: 'petrol' }))).toMatchObject({ status: 'resolved', od: { ratePercent: 17.5 } });
    const diesel = module.resolve(applyOverrides(noFuel, { fuel: 'diesel' }));
    expect(diesel).toMatchObject({ status: 'resolved', od: { ratePercent: 5 } });
    expect(cells(diesel.od)).toContain(`${PC}!D11`);
  });

  it('missing business type -> ambiguous with a question; answering rollover resolves (Old Business)', () => {
    const noBusiness = { ...base, businessType: missing<never>('not printed') };
    const r = module.resolve(noBusiness);
    expect(r.status).toBe('ambiguous');
    expect(r.questions.map((q) => q.fact)).toContain('businessType');
    expect(module.resolve(applyOverrides(noBusiness, { businessType: 'rollover' })).od.ratePercent).toBe(17.5);
  });

  it('footnote branch: 1197 cc skips PC!H3 -> C11 = 22.5%', () => {
    const r = run({ cc: 1197 });
    expect(r.od.ratePercent).toBe(22.5);
    expect(cells(r.od)).not.toContain(`${PC}!H3`);
  });

  it('footnote branch: a Tyre Protector add-on adds 2.5 points (PC!H6): 17.5 + 2.5 = 20%', () => {
    const r = run({}, { covers: found([...base.covers!.value!, 'Tyre Protector'], []) });
    expect(r.od.ratePercent).toBe(20);
    expect(cells(r.od)).toContain(`${PC}!H6`);
  });

  it('missing cc -> ambiguous 17.5% / 22.5% with a cc question; answering resolves', () => {
    const noCc = { ...base, cc: missing<never>('not printed') };
    const r = module.resolve(noCc);
    expect(candidateRates(r.od)).toEqual([17.5, 22.5]);
    expect(r.questions.map((q) => q.fact)).toEqual(['cc']);
    expect(module.resolve(applyOverrides(noCc, { cc: '998' })).od.ratePercent).toBe(17.5);
  });

  it('SAOD with zero depreciation: E11 20 - 5 (H3) - 2.5 (H4) = 12.5%; TP not applicable', () => {
    const r = run({ policyType: 'saod' });
    expect(r.od.ratePercent).toBe(12.5);
    expect(cells(r.od)).toEqual(expect.arrayContaining([`${PC}!E11`, `${PC}!H3`, `${PC}!H4`]));
    expect(r.tp.applicability).toBe('not_applicable');
    expect(r.status).toBe('resolved');
  });

  it('SATP -> OD not applicable; TP 0% from F11 cross-checked with MAIN!AR41 (<1000CC, DELHI)', () => {
    const r = run({ policyType: 'satp' });
    expect(r.od.applicability).toBe('not_applicable');
    expect(r.tp).toMatchObject({ applicability: 'applicable', ratePercent: 0 });
    expect(cells(r.tp)).toEqual(expect.arrayContaining([`${PC}!F11`, `${MAIN}!AR41`]));
    expect(r.status).toBe('resolved');
  });

  it('SATP with fuel and cc unknown still resolves: every F / AR:AT candidate is 0', () => {
    const r = run({ policyType: 'satp' }, { fuel: missing('x'), cc: missing('x') });
    expect(r).toMatchObject({ status: 'resolved', tp: { ratePercent: 0 } });
    expect(r.questions).toEqual([]);
  });

  it('unknown RTO UP-99 -> UP prefix spans rows 11 (C11) and 13 (C13): 17.5% / 7.5% with an RTO question', () => {
    const r = run({ rtoCode: 'UP-99' });
    expect(r.status).toBe('ambiguous');
    expect(candidateRates(r.od)).toEqual([7.5, 17.5]);
    expect(r.questions.map((q) => q.fact)).toEqual(['rtoCode']);
    expect(run({ rtoCode: 'UP-16' }).od.ratePercent).toBe(17.5);
  });

  it('unknown RTO KL-99 -> every KL RTO is PC row 9 (Kerala): C9 12.5 - 5 = 7.5%', () => {
    expect(run({ rtoCode: 'KL-99' })).toMatchObject({ status: 'resolved', od: { ratePercent: 7.5 } });
  });

  it('unknown RTO prefix ZZ -> unsupported', () => {
    expect(run({ rtoCode: 'ZZ-01' }).status).toBe('unsupported');
  });

  it('Chandigarh (RTO!C188) is not on the PC sheet: rows 12 (C12 20 - 5) and 13 (C13 12.5 - 5) stay open', () => {
    const r = run({ rtoCode: 'CH-01' });
    expect(r.status).toBe('ambiguous');
    expect(candidateRates(r.od)).toEqual([7.5, 15]);
    expect(r.questions).toEqual([]);
  });
});
