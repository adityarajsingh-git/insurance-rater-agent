// Shared helpers for policy-fact extraction: tolerant line search over page text,
// rupee / date / fuel parsing that survives OCR noise, and Fact constructors that
// always carry the page quote the value came from.
import type {
  Evidence,
  Fact,
  FactKey,
  FactOverrides,
  Fuel,
  PageText,
  PolicyFacts,
  PremiumFacts,
} from '../types';

export interface LineHit {
  page: number;
  line: string;
  match: RegExpMatchArray;
  source: PageText['source'];
}

export function lines(page: PageText): string[] {
  return page.text.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/** Every line (across pages, in order) matching `re`. */
export function findAll(pages: PageText[], re: RegExp, opts: { pages?: number[] } = {}): LineHit[] {
  const out: LineHit[] = [];
  for (const p of pages) {
    if (opts.pages && !opts.pages.includes(p.page)) continue;
    for (const line of lines(p)) {
      const m = line.match(re);
      if (m) out.push({ page: p.page, line, match: m, source: p.source });
    }
  }
  return out;
}

export function findFirst(pages: PageText[], re: RegExp, opts: { pages?: number[] } = {}): LineHit | null {
  return findAll(pages, re, opts)[0] ?? null;
}

/** Whole-page text joined with single spaces - for matches that OCR split across lines. */
export function flat(page: PageText): string {
  return page.text.replace(/\s+/g, ' ');
}

export function evidenceOf(hit: LineHit, quote?: string): Evidence {
  return { page: hit.page, quote: (quote ?? hit.line).slice(0, 240), source: hit.source };
}

export function found<T>(value: T, hit: LineHit | Evidence[], note?: string): Fact<T> {
  const evidence = Array.isArray(hit) ? hit : [evidenceOf(hit)];
  return { value, status: 'found', evidence, ...(note ? { note } : {}) };
}

export function derived<T>(value: T, evidence: Evidence[], note: string): Fact<T> {
  return { value, status: 'derived', evidence, note };
}

export function missing<T>(note: string, evidence: Evidence[] = []): Fact<T> {
  return { value: null, status: 'missing', evidence, note };
}

export function ambiguous<T>(candidates: T[], evidence: Evidence[], note: string): Fact<T> {
  return { value: null, status: 'ambiguous', evidence, note, candidates };
}

/**
 * Parses a rupee amount. Accepts "₹ 3,416.00", "Rs.3416", "INR 3416/-", and the OCR
 * misreads of the rupee sign ("¥", "%", "&", "T", "?"). Returns null when no number is present.
 */
export function parseMoney(s: string | null | undefined): number | null {
  if (!s) return null;
  const cleaned = s
    .replace(/(?:₹|rs\.?|inr|¥|[%&?T]\s)/gi, ' ')
    .replace(/\/-/g, '')
    .replace(/[^\d.,\- ]/g, ' ');
  const m = cleaned.match(/-?\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|-?\d+(?:\.\d{1,2})?/);
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** All money-looking numbers on a line, in order. */
export function moneyAll(s: string): number[] {
  const out: number[] = [];
  const re = /\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+\.\d{2}\b|\b\d+\b/g;
  for (const m of s.matchAll(re)) {
    const n = Number(m[0].replace(/,/g, ''));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function iso(y: number, m: number, d: number): string | null {
  if (y < 1950 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Parses the first date in `s` to ISO yyyy-mm-dd. Handles 28/03/2026, 28-03-2026, 2026-03-28,
 * 28-Mar-2026, 28 Mar, 2027, 28th March 2026. Day-first for numeric dates (Indian convention).
 */
export function parseDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.replace(/(\d)(st|nd|rd|th)\b/gi, '$1');
  let m = t.match(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = t.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/);
  if (m) return iso(+m[3], +m[2], +m[1]);
  m = t.match(/\b(\d{1,2})[\s\-/.]*([A-Za-z]{3,9})[\s,\-/.]*(\d{4})\b/);
  if (m && MONTHS[m[2].slice(0, 4).toLowerCase()] !== undefined) return iso(+m[3], MONTHS[m[2].slice(0, 4).toLowerCase()], +m[1]);
  if (m && MONTHS[m[2].slice(0, 3).toLowerCase()] !== undefined) return iso(+m[3], MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1]);
  return null;
}

export function parseAllDates(s: string): string[] {
  const out: string[] = [];
  const re = /\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b|\b\d{1,2}[-/.]\d{1,2}[-/.]\d{4}\b|\b\d{1,2}(?:st|nd|rd|th)?[\s\-/.]*[A-Za-z]{3,9}[\s,\-/.]*\d{4}\b/g;
  for (const m of s.matchAll(re)) {
    const d = parseDate(m[0]);
    if (d) out.push(d);
  }
  return out;
}

export function normaliseFuel(s: string | null | undefined): Fuel | null {
  if (!s) return null;
  const t = s.toLowerCase();
  if (/\b(electric|ev|battery)\b/.test(t)) return 'electric';
  if (/hybrid/.test(t)) return 'hybrid';
  if (/\bcng\b/.test(t)) return 'cng';
  if (/\blpg\b/.test(t)) return 'lpg';
  if (/diesel/.test(t)) return 'diesel';
  if (/petrol|gasoline/.test(t)) return 'petrol';
  return null;
}

/** Whole years between two ISO dates (age on the later date). */
export function yearsBetween(fromIso: string, toIso: string): number {
  const [fy, fm, fd] = fromIso.split('-').map(Number);
  const [ty, tm, td] = toIso.split('-').map(Number);
  let y = ty - fy;
  if (tm < fm || (tm === fm && td < fd)) y -= 1;
  return y;
}

export function emptyPremium(): PremiumFacts {
  return {
    netOd: missing('Not extracted'),
    netTp: missing('Not extracted'),
    netPremium: missing('Not extracted'),
    gst: missing('Not extracted'),
    total: missing('Not extracted'),
  };
}

export function emptyFacts(): PolicyFacts {
  const m = <T>() => missing<T>('Not extracted');
  return {
    insurerName: m(),
    insurer: m(),
    policyType: m(),
    businessType: m(),
    previousInsurer: m(),
    make: m(),
    model: m(),
    fuel: m(),
    cngLpgKit: m(),
    cc: m(),
    seats: m(),
    manufactureYear: m(),
    registrationDate: m(),
    vehicleAgeYears: m(),
    registrationNumber: m(),
    rtoCode: m(),
    rtoLocation: m(),
    state: m(),
    ncbPercent: m(),
    covers: m(),
    gwpSlab: missing('Broker business volume, not printed on a policy; asked only when a grid is slab-based'),
    policyStart: m(),
    policyEnd: m(),
    premium: emptyPremium(),
  };
}

export function getFact(facts: PolicyFacts, key: FactKey): Fact<unknown> {
  if (key.startsWith('premium.')) return facts.premium[key.slice(8) as keyof PremiumFacts] as Fact<unknown>;
  return facts[key as Exclude<FactKey, `premium.${string}`>] as Fact<unknown>;
}

function setFact(facts: PolicyFacts, key: FactKey, f: Fact<unknown>): void {
  if (key.startsWith('premium.')) (facts.premium as unknown as Record<string, Fact<unknown>>)[key.slice(8)] = f;
  else (facts as unknown as Record<string, Fact<unknown>>)[key] = f;
}

const PREMIUM_KEYS = Object.keys(emptyPremium()).map((k) => `premium.${k}` as FactKey);
/** Every fact key, premium components as `premium.<name>`. */
export const ALL_FACT_KEYS: FactKey[] = [
  ...(Object.keys(emptyFacts()).filter((k) => k !== 'premium') as FactKey[]),
  ...PREMIUM_KEYS,
];

/**
 * Fills facts that are `missing` in `primary` with the `found` / `derived` value from `secondary`
 * (an extraction of the same document from a second OCR pass). Anything the primary pass read,
 * including ambiguous facts, is kept as is, so the second pass can only add information.
 * Returns the keys it filled.
 */
export function fillMissing(primary: PolicyFacts, secondary: PolicyFacts, note: string): FactKey[] {
  const filled: FactKey[] = [];
  for (const key of ALL_FACT_KEYS) {
    const a = getFact(primary, key);
    const b = getFact(secondary, key);
    if (a?.status !== 'missing' || !b || (b.status !== 'found' && b.status !== 'derived')) continue;
    setFact(primary, key, { ...b, note: b.note ? `${b.note}. ${note}` : note });
    filled.push(key);
  }
  return filled;
}

const NUMERIC_KEYS = new Set<FactKey>([
  'cc', 'seats', 'manufactureYear', 'vehicleAgeYears', 'ncbPercent',
  'premium.netOd', 'premium.netTp', 'premium.netPremium', 'premium.gst', 'premium.total',
]);

/**
 * Applies user answers / corrections. A user value replaces the extracted one but keeps the
 * extracted evidence, so the trace shows both what the document said and what the user chose.
 */
export function applyOverrides(facts: PolicyFacts, overrides: FactOverrides): PolicyFacts {
  const out: PolicyFacts = structuredClone(facts);
  for (const [k, raw] of Object.entries(overrides)) {
    if (raw === undefined) continue;
    const key = k as FactKey;
    const prev = getFact(out, key);
    let value: unknown = raw;
    if (raw !== null && NUMERIC_KEYS.has(key)) {
      const n = typeof raw === 'number' ? raw : parseMoney(String(raw));
      if (n === null) continue;
      value = n;
    }
    if (key === 'cngLpgKit' && typeof raw === 'string') value = /^(true|yes|1)$/i.test(raw);
    if (key === 'covers' && typeof raw === 'string') value = raw.split(',').map((s) => s.trim()).filter(Boolean);
    setFact(out, key, {
      value,
      status: 'user',
      evidence: [{ quote: `Answered by the user: ${String(raw)}`, source: 'user' }, ...(prev?.evidence ?? [])],
      note: prev?.value !== undefined && prev?.value !== null && prev.value !== value
        ? `User changed the extracted value ${String(prev.value)}`
        : prev?.note,
    });
  }
  return out;
}
