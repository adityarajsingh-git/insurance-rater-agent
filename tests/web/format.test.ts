import { describe, expect, it } from 'vitest';
import type { RateComponent } from '../../src/core/types';
import type { RunSummary } from '../../src/server/runs';
import {
  FACT_INPUTS, INSURERS, matchesQuery, policyTypeLabel, rateDisplay, relTime, toInputValue, totalBrokerage, verdictHeadline,
} from '../../src/web/format';
import { existsSync } from 'node:fs';

const comp = (over: Partial<RateComponent>): RateComponent => ({
  applicability: 'applicable', ratePercent: null, appliesTo: 'x', premiumBase: null, expectedBrokerage: null, reason: '', citations: [], ...over,
});

describe('rateDisplay', () => {
  it('shows the single rate when resolved', () => expect(rateDisplay(comp({ ratePercent: 29.5 }))).toBe('29.5%'));
  it('shows the candidate range while ambiguous', () => {
    const c = comp({ candidates: [23, 15, 17.5].map((r) => ({ ratePercent: r, assumption: '', citations: [] })) });
    expect(rateDisplay(c)).toBe('15–23%');
  });
  it('collapses equal candidates and handles no data', () => {
    expect(rateDisplay(comp({ candidates: [{ ratePercent: 20, assumption: '', citations: [] }, { ratePercent: 20, assumption: '', citations: [] }] }))).toBe('20%');
    expect(rateDisplay(comp({}))).toBe('—');
  });
});

describe('totalBrokerage', () => {
  it('adds OD and TP brokerage, rounded to paise', () => {
    expect(totalBrokerage({ od: comp({ expectedBrokerage: 1852.19 }), tp: comp({ expectedBrokerage: 877.68 }) })).toBe(2729.87);
  });
  it('skips components that are not applicable or have no amount', () => {
    expect(totalBrokerage({ od: comp({ applicability: 'not_applicable', expectedBrokerage: 99 }), tp: comp({ expectedBrokerage: 1007.72 }) })).toBe(1007.72);
    expect(totalBrokerage({ od: comp({}), tp: comp({ applicability: 'ambiguous' }) })).toBeNull();
  });
});

describe('verdictHeadline', () => {
  it('matches the result status and the number of open questions', () => {
    expect(verdictHeadline({ status: 'resolved', questions: [] })).toBe('Commission rate resolved');
    expect(verdictHeadline({ status: 'ambiguous', questions: [{ fact: 'gwpSlab', question: '?' }] })).toBe('One answer needed to settle the rate');
    expect(verdictHeadline({ status: 'ambiguous', questions: [{ fact: 'fuel', question: '?' }, { fact: 'cc', question: '?' }] })).toBe('2 answers needed to settle the rate');
    expect(verdictHeadline({ status: 'unsupported', questions: [] })).toMatch(/No supplied grid/);
  });
});

describe('relTime', () => {
  const now = Date.parse('2026-11-25T12:00:00Z');
  it('uses short relative units, then a date', () => {
    expect(relTime('2026-11-25T11:59:30Z', now)).toBe('just now');
    expect(relTime('2026-11-25T11:15:00Z', now)).toBe('45m ago');
    expect(relTime('2026-11-25T02:00:00Z', now)).toBe('10h ago');
    expect(relTime('2026-11-22T12:00:00Z', now)).toBe('3d ago');
    expect(relTime('2026-10-01T12:00:00Z', now)).toMatch(/2026/);
  });
});

describe('matchesQuery', () => {
  const s: RunSummary = {
    id: '1', createdAt: '2026-11-25T00:00:00Z', fileName: 'pvt-car-satp-go-digit.pdf', status: 'analysed',
    insurer: 'godigit', policyType: 'satp', resultStatus: 'resolved', odRate: null, tpRate: 29.5,
  };
  it('matches file name, insurer display name, policy type and status, all words required', () => {
    expect(matchesQuery(s, '')).toBe(true);
    expect(matchesQuery(s, 'go digit')).toBe(true);
    expect(matchesQuery(s, 'SATP resolved')).toBe(true);
    expect(matchesQuery(s, 'hdfc')).toBe(false);
    expect(matchesQuery(s, 'digit ambiguous')).toBe(false);
  });
});

describe('labels and inputs', () => {
  it('labels policy types', () => {
    expect(policyTypeLabel('package')).toBe('Comprehensive');
    expect(policyTypeLabel('satp', 'long')).toBe('Third-party only (SATP)');
    expect(policyTypeLabel(null)).toBeNull();
  });
  it('formats current values for the correction inputs', () => {
    expect(toInputValue(true, FACT_INPUTS.cngLpgKit!)).toBe('yes');
    expect(toInputValue(['Nil Dep', 'RTI'], FACT_INPUTS.covers!)).toBe('Nil Dep, RTI');
    expect(toInputValue('2025-12-23T00:00:00.000Z', FACT_INPUTS.policyStart!)).toBe('2025-12-23');
    expect(toInputValue(null, FACT_INPUTS.cc!)).toBe('');
  });
  it('offers only values the engine understands for enum facts', () => {
    const fuel = FACT_INPUTS.fuel!;
    expect(fuel.kind === 'select' && fuel.options.map((o) => o.value)).toEqual(['petrol', 'diesel', 'cng', 'lpg', 'electric', 'hybrid']);
    expect(FACT_INPUTS.gwpSlab).toBeUndefined(); // answered through the module's own question options only
  });
  it('points every "Try sample" button at a sample policy that exists', () => {
    for (const m of Object.values(INSURERS)) expect(existsSync(`sample-policies/${m.sample}`), m.sample).toBe(true);
  });
});
