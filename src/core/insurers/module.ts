// Contract every insurer module implements, plus helpers that build RateComponent /
// RateResult values consistently (rounding, not-applicable vs unsupported, citations).
import type {
  Applicability,
  Citation,
  ClarifyingQuestion,
  Evidence,
  InsurerId,
  PageText,
  PolicyFacts,
  RateCandidate,
  RateComponent,
  RateResult,
  TraceStep,
} from '../types';

export interface Detection {
  insurer: InsurerId;
  score: number; // 0..1, how sure the document belongs to this insurer
  evidence: Evidence[];
}

export interface InsurerModule {
  id: InsurerId;
  displayName: string;
  /** Recognises the insurer from page text. Returns null when there is no sign of it. */
  detect(pages: PageText[]): Detection | null;
  /** Extracts every fact the grid lookup needs, each with page evidence. Never throws on odd input. */
  extract(pages: PageText[]): PolicyFacts;
  /** Deterministic grid lookup. Facts may include user overrides (status 'user'). */
  resolve(facts: PolicyFacts): RateResult;
}

/** Rupee amount = base x rate%, rounded to paise. */
export function brokerage(base: number | null, ratePercent: number | null): number | null {
  if (base === null || ratePercent === null) return null;
  return Math.round(base * ratePercent) / 100;
}

/** Fraction (0.295) or percent (29.5) cell value to a percent with float noise removed. */
export function toPercent(v: number, cellIsFraction: boolean): number {
  const p = cellIsFraction ? v * 100 : v;
  return Math.round(p * 10000) / 10000;
}

export function component(
  applicability: Applicability,
  opts: {
    ratePercent?: number | null;
    appliesTo: string;
    premiumBase?: number | null;
    reason: string;
    citations?: Citation[];
    candidates?: RateCandidate[];
  },
): RateComponent {
  const ratePercent = applicability === 'applicable' ? (opts.ratePercent ?? null) : null;
  const premiumBase = opts.premiumBase ?? null;
  return {
    applicability,
    ratePercent,
    appliesTo: opts.appliesTo,
    premiumBase,
    expectedBrokerage: brokerage(premiumBase, ratePercent),
    reason: opts.reason,
    citations: opts.citations ?? [],
    ...(opts.candidates?.length ? { candidates: opts.candidates } : {}),
  };
}

export function notApplicable(appliesTo: string, reason: string, citations: Citation[] = []): RateComponent {
  return component('not_applicable', { appliesTo, reason, citations });
}

export function unsupported(appliesTo: string, reason: string, citations: Citation[] = []): RateComponent {
  return component('unsupported', { appliesTo, reason, citations });
}

export function ambiguousComponent(
  appliesTo: string,
  reason: string,
  candidates: RateCandidate[],
  premiumBase: number | null = null,
): RateComponent {
  return component('ambiguous', { appliesTo, reason, candidates, premiumBase, citations: candidates.flatMap((c) => c.citations) });
}

/** Overall status: unsupported if any applicable component is unsupported, ambiguous if any is ambiguous. */
export function overallStatus(od: RateComponent, tp: RateComponent): RateResult['status'] {
  const parts = [od.applicability, tp.applicability];
  if (parts.includes('unsupported')) return 'unsupported';
  if (parts.includes('ambiguous')) return 'ambiguous';
  return 'resolved';
}

export function pct(n: number | null): string {
  return n === null ? 'n/a' : `${Number(n.toFixed(4))}%`;
}

export function buildResult(args: {
  insurer: InsurerId | null;
  grid: RateResult['grid'];
  od: RateComponent;
  tp: RateComponent;
  confidence: RateResult['confidence'];
  trace: TraceStep[];
  questions?: ClarifyingQuestion[];
  summary?: string;
}): RateResult {
  const status = overallStatus(args.od, args.tp);
  const describe = (name: string, c: RateComponent) =>
    c.applicability === 'applicable'
      ? `${name} ${pct(c.ratePercent)} on ${c.appliesTo}`
      : c.applicability === 'not_applicable'
        ? `${name} not applicable`
        : c.applicability === 'ambiguous'
          ? `${name} ambiguous (${(c.candidates ?? []).map((x) => pct(x.ratePercent)).join(' / ')})`
          : `${name} unsupported`;
  return {
    status,
    insurer: args.insurer,
    grid: args.grid,
    od: args.od,
    tp: args.tp,
    confidence: args.confidence,
    summary: args.summary ?? `${describe('OD', args.od)}; ${describe('TP', args.tp)}.`,
    trace: args.trace,
    questions: args.questions ?? [],
  };
}
