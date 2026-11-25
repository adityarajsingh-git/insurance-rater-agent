// Go Digit module: grid normaliser, sample extraction on both OCR flavours, detection, and
// synthetic resolution cases. Expected rates are read from the workbook cells named in each test.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';
import { build, OUT, ROOT, SOURCE } from '../scripts/grids/godigit';
import { applyOverrides } from '../src/core/extract/common';
import { module } from '../src/core/insurers/godigit';
import { rtoKeys } from '../src/core/insurers/godigit/resolve';
import type { FactOverrides, PageText, PolicyFacts, RateComponent, RateResult } from '../src/core/types';

const SAMPLE = 'pvt-car-satp-go-digit';
const load = (dir: string, name: string): PageText[] => JSON.parse(readFileSync(join(ROOT, 'tests/fixtures', dir, `${name}.json`), 'utf8'));
const cells = (c: RateComponent) => c.citations.map((x) => `${x.sheet}!${x.cell}`);
const sample = module.extract(load('ocr', SAMPLE));
const run = (o: FactOverrides, edit?: (f: PolicyFacts) => void): RateResult => {
  const f = applyOverrides(sample, o);
  edit?.(f);
  return module.resolve(f);
};

describe('godigit grid normaliser', () => {
  it('rebuilds the committed JSON exactly (its structural asserts run inside build)', () => {
    expect(build()).toEqual(JSON.parse(readFileSync(join(ROOT, OUT), 'utf8')));
  });

  it('keeps the decisive cells of the workbook', () => {
    const wb = XLSX.readFile(join(ROOT, SOURCE));
    const v = (sheet: string, a: string) => wb.Sheets[sheet][a]?.v;
    expect([v('4W  RTO', 'B1609'), v('4W  RTO', 'C1609')]).toEqual(['UP78', 'UP_Bad']);
    expect([v('4W SATP', 'B293'), v('4W SATP', 'C293'), v('4W SATP', 'D293'), v('4W SATP', 'E293')]).toEqual(['UP_Bad', 'Petrol>1000', 'All', 0.295]);
    const grid = JSON.parse(readFileSync(join(ROOT, OUT), 'utf8'));
    expect(grid.rto.UP78).toEqual([1609, 'UP_Bad', 'UP']);
    expect(grid.satp.clusters.UP_BAD.rows).toEqual([289, 290, 291, 292, 293]);
    // Float noise removed: E84 = 0.29999999999999993, E264 = 0.049999999999999996.
    expect(grid.satp.rows.find((r: { row: number }) => r.row === 84).pct).toBe(30);
    expect(grid.satp.rows.find((r: { row: number }) => r.row === 264).pct).toBe(5);
  });
});

describe.each(['ocr', 'vision'])('sample policy (%s text)', (dir) => {
  const facts = module.extract(load(dir, SAMPLE));

  it('extracts the key facts with page evidence', () => {
    const on = (f: { evidence: { page?: number }[] }, page: number) => f.evidence.some((e) => e.page === page);
    expect(facts.insurer.value).toBe('godigit');
    expect(facts.policyType).toMatchObject({ value: 'satp', status: 'found' });
    expect(on(facts.policyType, 1)).toBe(true);
    expect(facts.previousInsurer.value).toMatch(/Go Digit/);
    expect(facts.businessType).toMatchObject({ value: 'renewal', status: 'derived' });
    expect(on(facts.businessType, 2)).toBe(true);
    expect(facts.registrationNumber.value).toBe('UP78FZ1372');
    expect(facts.rtoCode.value).toBe('UP-78');
    expect(facts.rtoLocation.value).toMatch(/Kanpur Nagar.*UTTAR PRADESH/);
    expect(facts.make.value).toBe('HYUNDAI');
    expect(facts.model.value).toBe('SANTRO NEW/1.1MT CORPORATE');
    expect(facts.fuel.value).toBe('petrol');
    expect(facts.cngLpgKit).toMatchObject({ value: false, status: 'derived' });
    expect(facts.cc.value).toBe(1086);
    expect(on(facts.cc, 1)).toBe(true);
    expect(facts.manufactureYear.status).toBe('missing'); // "0001-01-01" placeholder
    expect(facts.vehicleAgeYears).toMatchObject({ status: 'ambiguous', candidates: [6, 7] }); // Year of Regn. 2019 only
    expect(facts.policyStart.value).toBe('2026-03-25');
    expect(facts.policyEnd.value).toBe('2027-03-24');
    expect(facts.premium.netTp.value).toBe(3416);
    expect(on(facts.premium.netTp, 2)).toBe(true);
    expect(facts.premium.netPremium.value).toBe(3466);
    expect(facts.premium.gst.value).toBe(623.88);
    expect(facts.premium.total.value).toBe(4089.88);
    expect(facts.premium.netOd.value).toBeNull();
    for (const f of [facts.policyType, facts.registrationNumber, facts.cc, facts.fuel, facts.premium.netTp]) {
      expect(f.evidence[0].quote.length).toBeGreaterThan(0);
    }
  });

  it("resolves TP 29.5% from '4W SATP'!E293 via '4W  RTO'!B1609/C1609, OD not applicable", () => {
    const r = module.resolve(facts);
    expect(r.status).toBe('resolved');
    expect(r.tp).toMatchObject({ applicability: 'applicable', ratePercent: 29.5, premiumBase: 3416, expectedBrokerage: 1007.72 });
    expect(cells(r.tp)).toEqual(expect.arrayContaining(['4W  RTO!B1609', '4W  RTO!C1609', '4W SATP!C293', '4W SATP!E293']));
    expect(r.tp.citations.every((c) => c.file === "raters/godigit/march-2026/Large Insurance Brokers Mar'26 - Shared.xlsx")).toBe(true);
    expect(r.od).toMatchObject({ applicability: 'not_applicable', ratePercent: null });
    expect(r.grid?.effective).toMatch(/^2026-03-01 to 2026-03-31/);
    expect(r.questions).toEqual([]);
    expect(r.confidence.level).toBe('medium'); // the no-kit fact is inferred from an empty bi-fuel line
    const base = r.trace.find((s) => s.title.startsWith('Premium base'));
    expect(base?.detail).toMatch(/3416\.00.*3466\.00/);
    expect(r.trace.find((s) => s.title === 'Location cross-check')?.outcome).toBe('ok'); // 'CV RTO Mapping'!A1807:C1807
  });
});

describe('godigit detection', () => {
  it('recognises the sample and not the other insurers', () => {
    expect(module.detect(load('ocr', SAMPLE))?.score).toBe(1);
    for (const other of ['pvt-car-comprehensive-hdfc-ergo', 'pvt-car-comprehensive-reliance', 'pvt-car-satp-tata-aig']) {
      const d = module.detect(load('ocr', other));
      expect(d === null || d.score < 0.3).toBe(true);
    }
  });
});

describe('godigit synthetic cases', () => {
  it('derives grid keys from plates and codes', () => {
    expect(rtoKeys('DL3CAB1234')).toEqual(['DL3C', 'DL03']);
    expect(rtoKeys('UP-78')).toEqual(['UP78']);
    expect(rtoKeys('MH1AB1234')).toEqual(['MH1A', 'MH01']);
  });

  it("another geography: UP11 -> '4W  RTO'!C1542 UP_Good -> '4W SATP'!E299 = 45%", () => {
    const r = run({ registrationNumber: 'UP11AB1234' });
    expect(r.tp).toMatchObject({ applicability: 'applicable', ratePercent: 45 });
    expect(cells(r.tp)).toContain('4W SATP!E299');
    expect(r.trace.find((s) => s.title === 'Location cross-check')?.outcome).toBe('warn'); // Saharanpur, same state
  });

  it("Delhi plate DL3C -> '4W  RTO'!C272 DELHI -> 'Delhi/NCR' Petrol 1000-1500 '4W SATP'!E71 = 32%", () => {
    const r = run({ registrationNumber: 'DL3CAB1234', rtoLocation: 'Delhi', state: 'Delhi' });
    expect(r.tp).toMatchObject({ applicability: 'applicable', ratePercent: 32 });
    expect(cells(r.tp)).toEqual(expect.arrayContaining(['4W  RTO!B272', '4W SATP!E71']));
  });

  it("All_India_Decline: CG05 ('4W  RTO'!C165) -> unsupported DECLINED citing '4W SATP'!B3:E8", () => {
    const r = run({ rtoCode: 'CG05' });
    expect(r.status).toBe('unsupported');
    expect(r.tp.reason).toMatch(/^DECLINED/);
    expect(cells(r.tp)).toContain('4W SATP!B3:E8');
  });

  it("note F120: HR_Bad petrol 1001-1500 cc under 10 years is DECLINED; at 12 years E120 = 5% applies", () => {
    const young = run({ rtoCode: 'HR04', vehicleAgeYears: 7 });
    expect(young.tp.applicability).toBe('unsupported');
    expect(young.tp.reason).toMatch(/^DECLINED.*F120/);
    expect(cells(young.tp)).toContain('4W SATP!F120');
    expect(run({ rtoCode: 'HR04', vehicleAgeYears: 12 }).tp).toMatchObject({ applicability: 'applicable', ratePercent: 5 });
  });

  it("Kerala overlap: E162 (1000-1500, <10) beats E163 and note F163 declines; at 12 years E163 = 21%", () => {
    expect(run({ rtoCode: 'KL02', vehicleAgeYears: 7 }).tp.reason).toMatch(/^DECLINED.*F163/);
    expect(run({ rtoCode: 'KL02', vehicleAgeYears: 12 }).tp).toMatchObject({ applicability: 'applicable', ratePercent: 21 });
  });

  it("note F70 'Few RTOs for <10 age are declined': Delhi petrol 998 cc -> ambiguous, E70 = 18.5% or declined", () => {
    const r = run({ rtoCode: 'DL01', cc: 998, vehicleAgeYears: 5 });
    expect(r.status).toBe('ambiguous');
    expect(r.tp.candidates?.map((c) => c.ratePercent)).toEqual([18.5]);
    expect(cells(r.tp)).toContain('4W SATP!F70');
  });

  it('a policy type the workbook lacks is unsupported (SAOD; package renewal)', () => {
    const saod = run({ policyType: 'saod' });
    expect([saod.status, saod.od.applicability, saod.tp.applicability]).toEqual(['unsupported', 'unsupported', 'unsupported']);
    expect(run({ policyType: 'package', businessType: 'renewal' }).status).toBe('unsupported');
  });

  it("missing cc -> ambiguous between E292 (15%) and E293 (29.5%) with a question; answering resolves", () => {
    const r = run({ cc: null });
    expect(r.status).toBe('ambiguous');
    expect(r.tp.candidates?.map((c) => c.ratePercent).sort()).toEqual([15, 29.5]);
    expect(r.questions.map((q) => q.fact)).toEqual(['cc']);
    const answered = module.resolve(applyOverrides(applyOverrides(sample, { cc: null }), { cc: 1086 }));
    expect(answered.status).toBe('resolved');
    expect(answered.tp.ratePercent).toBe(29.5);
  });

  it("age band flip: Guj_Bad 1200 cc aged 9 or 10 -> E92 51% vs E93 47.5%; answering 9 gives 51%", () => {
    const flip = (f: PolicyFacts) => {
      f.vehicleAgeYears = { value: null, status: 'ambiguous', evidence: [], candidates: [9, 10] };
    };
    const r = run({ rtoCode: 'GJ03', cc: 1200 }, flip);
    expect(r.status).toBe('ambiguous');
    expect(r.tp.candidates?.map((c) => c.ratePercent).sort()).toEqual([47.5, 51]);
    expect(r.questions[0]).toMatchObject({ fact: 'vehicleAgeYears', options: [{ value: '9' }, { value: '10' }] });
    expect(run({ rtoCode: 'GJ03', cc: 1200, vehicleAgeYears: 9 }).tp.ratePercent).toBe(51);
  });

  it("CNG kit on UP_Bad -> E289 = 0: resolved at 0% with the decline warning", () => {
    const r = run({ cngLpgKit: true });
    expect(r.tp).toMatchObject({ applicability: 'applicable', ratePercent: 0 });
    expect(r.trace.some((s) => s.outcome === 'warn' && s.detail.includes('0% CD2'))).toBe(true);
  });

  it('LPG has no segment: ambiguous with the CNG row (E289) and a fuel question; electric is unsupported', () => {
    const lpg = run({ fuel: 'lpg' });
    expect(lpg.status).toBe('ambiguous');
    expect(lpg.tp.candidates?.map((c) => c.ratePercent)).toEqual([0]);
    expect(lpg.questions[0].fact).toBe('fuel');
    expect(run({ fuel: 'cng' }).status).toBe('resolved');
    expect(run({ fuel: 'electric' }).tp.applicability).toBe('unsupported');
  });

  it("no grid row: HP_Good (HP21) has no CNG row in B111:B115 -> unsupported", () => {
    const r = run({ rtoCode: 'HP21', cngLpgKit: true });
    expect(r.tp.applicability).toBe('unsupported');
    expect(r.tp.reason).toMatch(/No '4W SATP' row/);
  });

  it('unknown RTO UP99 is unsupported', () => {
    const r = run({ rtoCode: 'UP99' });
    expect(r.status).toBe('unsupported');
    expect(r.tp.reason).toMatch(/UP99.*not in the Go Digit 4W RTO map/);
  });

  it("registration vs printed location disagree -> ambiguous + rtoCode question; HR26 answer -> NCR E71 = 32%", () => {
    const r = run({ registrationNumber: 'HR26AB1234' });
    expect(r.status).toBe('ambiguous');
    expect(r.tp.candidates?.map((c) => c.ratePercent)).toEqual([32]); // '4W  RTO'!C632 NCR -> E71
    expect(r.questions[0].fact).toBe('rtoCode');
    expect(run({ registrationNumber: 'HR26AB1234', rtoCode: 'HR26' }).tp).toMatchObject({ applicability: 'applicable', ratePercent: 32 });
  });

  it('missing registration -> ambiguous + question; answering resolves', () => {
    const none = applyOverrides(sample, { registrationNumber: null, rtoCode: null });
    expect(module.resolve(none).questions[0].fact).toBe('registrationNumber');
    expect(module.resolve(applyOverrides(none, { registrationNumber: 'UP78FZ1372' })).tp.ratePercent).toBe(29.5);
  });

  it('a start date outside March 2026 resolves with a warning', () => {
    const r = run({ policyStart: '2026-05-01' });
    expect(r.status).toBe('resolved');
    expect(r.trace[0]).toMatchObject({ title: 'Grid and validity', outcome: 'warn' });
  });

  it("new-business package: UP78 -> '4W  RTO'!D1609 'UP' -> 1+3 Hyundai E30 = 25% or 3+3 I30 = 19.5%, OD/TP split ambiguous", () => {
    const r = run({ policyType: 'package', businessType: 'new' });
    expect(r.status).toBe('ambiguous');
    for (const c of [r.od, r.tp]) {
      expect(c.candidates?.map((x) => x.ratePercent)).toEqual([25, 19.5]);
      expect(cells(c)).toEqual(expect.arrayContaining(['4W New Business 1+3!E30', '4W New Business 1+3!I30']));
    }
  });
});
