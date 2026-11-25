// Pure display helpers for the web UI (no React), so they can be unit-tested in Node.
import type { FactKey, FactStatus, InsurerId, PolicyType, RateComponent, RateResult } from '../core/types';
import type { RunSummary } from '../server/runs';

export interface InsurerMeta {
  name: string;
  /** Grid source as it sits in `raters/`, shown on the home screen. */
  grid: string;
  gridKind: string;
  /** Sample policy served at `/<sample>` (vite publicDir = sample-policies). */
  sample: string;
  sampleLabel: string;
}

export const INSURERS: Record<InsurerId, InsurerMeta> = {
  godigit: {
    name: 'Go Digit',
    grid: "Large Insurance Brokers Mar'26 - Shared.xlsx",
    gridKind: 'Workbook · Mar 2026',
    sample: 'pvt-car-satp-go-digit.pdf',
    sampleLabel: 'Private car · third-party only',
  },
  reliance: {
    name: 'Reliance General',
    grid: 'Reliance Broking Premier FEB 26 Grid.xlsx',
    gridKind: 'Workbook · Feb 2026',
    sample: 'pvt-car-comprehensive-reliance.pdf',
    sampleLabel: 'Private car · comprehensive',
  },
  'hdfc-ergo': {
    name: 'HDFC ERGO',
    grid: "Pvt Car New Grid Eff 1st Feb'25 (HDFC ergo) 1.pdf",
    gridKind: 'PDF rate card · Feb 2025',
    sample: 'pvt-car-comprehensive-hdfc-ergo.pdf',
    sampleLabel: 'Private car · comprehensive',
  },
  'tata-aig': {
    name: 'Tata AIG',
    grid: "Tata AIG Standard Grid_Communication_Mar'26_F_v2_0212.xlsx",
    gridKind: 'Workbook · Mar 2026',
    sample: 'pvt-car-satp-tata-aig.pdf',
    sampleLabel: 'Private car · third-party only',
  },
};

export const insurerName = (id: InsurerId | null | undefined) => (id ? (INSURERS[id]?.name ?? id) : null);

const POLICY_TYPE: Record<PolicyType, { short: string; long: string }> = {
  package: { short: 'Comprehensive', long: 'Comprehensive (package)' },
  satp: { short: 'SATP', long: 'Third-party only (SATP)' },
  saod: { short: 'SAOD', long: 'Own-damage only (SAOD)' },
};
export const policyTypeLabel = (t: PolicyType | null | undefined, form: 'short' | 'long' = 'short') =>
  t ? (POLICY_TYPE[t]?.[form] ?? t) : null;

export const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export const fmtDay = (iso: string) =>
  new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

export const fmtRate = (r: number | null | undefined) => (r == null ? '—' : `${r}%`);

export const fmtRupees = (n: number | null | undefined) =>
  n == null ? '—' : `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const fmtBytes = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** "just now", "5m ago", "3h ago", "2d ago", then a plain date. */
export function relTime(iso: string, now = Date.now()): string {
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return fmtDay(iso);
}

/** The single rate, or the candidate range ("15–23%") while the rate is still ambiguous. */
export function rateDisplay(c: RateComponent): string {
  if (c.ratePercent != null) return fmtRate(c.ratePercent);
  const rates = (c.candidates ?? []).map((k) => k.ratePercent);
  if (!rates.length) return '—';
  const lo = Math.min(...rates);
  const hi = Math.max(...rates);
  return lo === hi ? fmtRate(lo) : `${lo}–${hi}%`;
}

/** Sum of the expected brokerage over the components that have one; null when neither does. */
export function totalBrokerage(r: Pick<RateResult, 'od' | 'tp'>): number | null {
  const parts = [r.od, r.tp].filter((c) => c.applicability === 'applicable' && c.expectedBrokerage != null);
  if (!parts.length) return null;
  return Math.round(parts.reduce((sum, c) => sum + (c.expectedBrokerage ?? 0), 0) * 100) / 100;
}

export function verdictHeadline(r: Pick<RateResult, 'status' | 'questions'>): string {
  if (r.status === 'resolved') return 'Commission rate resolved';
  if (r.status === 'ambiguous')
    return r.questions.length === 1 ? 'One answer needed to settle the rate' : r.questions.length > 1 ? `${r.questions.length} answers needed to settle the rate` : 'More than one grid rate fits';
  return 'No supplied grid can rate this policy';
}

export const STATUS_HINT: Record<FactStatus, string> = {
  found: 'Read from the policy',
  derived: 'Worked out from other facts',
  missing: 'Not found in the policy',
  ambiguous: 'The policy supports more than one value',
  user: 'Set by you',
};

export const needsAttention = (s: FactStatus) => s === 'missing' || s === 'ambiguous';

/** History search: file name, insurer, policy type and status, case-insensitive, all words must match. */
export function matchesQuery(s: RunSummary, query: string): boolean {
  const hay = [s.fileName, insurerName(s.insurer), s.insurer, policyTypeLabel(s.policyType), s.policyType, s.resultStatus ?? s.status]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

/** Inline fact correction: which input each fact gets. Facts not listed here are read-only in the table. */
export type FactInput =
  | { kind: 'text' }
  | { kind: 'number' }
  | { kind: 'date' }
  | { kind: 'select'; options: { value: string; label: string }[] };

const opts = (pairs: [string, string][]) => pairs.map(([value, label]) => ({ value, label }));

export const FACT_INPUTS: Partial<Record<FactKey, FactInput>> = {
  insurer: { kind: 'select', options: (Object.keys(INSURERS) as InsurerId[]).map((id) => ({ value: id, label: INSURERS[id].name })) },
  policyType: { kind: 'select', options: opts([['package', 'Comprehensive (package)'], ['satp', 'Third-party only (SATP)'], ['saod', 'Own-damage only (SAOD)']]) },
  businessType: { kind: 'select', options: opts([['new', 'New'], ['renewal', 'Renewal'], ['rollover', 'Rollover']]) },
  fuel: { kind: 'select', options: opts([['petrol', 'Petrol'], ['diesel', 'Diesel'], ['cng', 'CNG'], ['lpg', 'LPG'], ['electric', 'Electric'], ['hybrid', 'Hybrid']]) },
  cngLpgKit: { kind: 'select', options: opts([['yes', 'Yes'], ['no', 'No']]) },
  previousInsurer: { kind: 'text' },
  make: { kind: 'text' },
  model: { kind: 'text' },
  cc: { kind: 'number' },
  seats: { kind: 'number' },
  manufactureYear: { kind: 'number' },
  registrationDate: { kind: 'date' },
  vehicleAgeYears: { kind: 'number' },
  registrationNumber: { kind: 'text' },
  rtoCode: { kind: 'text' },
  rtoLocation: { kind: 'text' },
  state: { kind: 'text' },
  ncbPercent: { kind: 'number' },
  covers: { kind: 'text' },
  policyStart: { kind: 'date' },
  policyEnd: { kind: 'date' },
  'premium.netOd': { kind: 'number' },
  'premium.netTp': { kind: 'number' },
  'premium.netPremium': { kind: 'number' },
  'premium.gst': { kind: 'number' },
  'premium.total': { kind: 'number' },
};

/** The current value as the edit input expects it (select values, yyyy-mm-dd, plain numbers). */
export function toInputValue(v: unknown, input: FactInput): string {
  if (v == null) return '';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (Array.isArray(v)) return v.join(', ');
  if (input.kind === 'date') return String(v).slice(0, 10);
  return String(v);
}
