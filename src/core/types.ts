// Shared types for the rater agent: page text in, policy facts, grid citations,
// and the structured result the frontend renders and the store persists.

export type InsurerId = 'hdfc-ergo' | 'reliance' | 'godigit' | 'tata-aig';

export type PageTextSource = 'text-layer' | 'ocr';

export interface PageText {
  page: number; // 1-based
  text: string;
  source: PageTextSource;
  confidence?: number; // OCR mean confidence 0-100, when source is ocr
  /**
   * OCR of a contrast-enhanced render of the same page (see src/core/extract/ocr-prep.ts). Reads faint grey
   * de-identified fields that the plain pass drops, but loses some text on shaded rows, so the agent uses it
   * only to fill facts the plain pass left missing.
   */
  enhancedText?: string;
}

export type EvidenceSource = PageTextSource | 'user' | 'derived';

export interface Evidence {
  page?: number;
  quote: string;
  source: EvidenceSource;
}

export type FactStatus = 'found' | 'derived' | 'missing' | 'ambiguous' | 'user';

export interface Fact<T> {
  value: T | null;
  status: FactStatus;
  evidence: Evidence[];
  note?: string;
  candidates?: T[];
}

export type PolicyType = 'package' | 'satp' | 'saod';
export type BusinessType = 'new' | 'renewal' | 'rollover';
export type Fuel = 'petrol' | 'diesel' | 'cng' | 'lpg' | 'electric' | 'hybrid';

export interface PremiumFacts {
  netOd: Fact<number>; // own-damage premium after discounts, incl. add-ons when the schedule folds them in
  netTp: Fact<number>; // liability premium (basic TP + legal liabilities + PA owner-driver when shown inside it)
  netPremium: Fact<number>; // total before GST
  gst: Fact<number>;
  total: Fact<number>; // total payable incl. GST
}

export interface PolicyFacts {
  insurerName: Fact<string>;
  insurer: Fact<InsurerId>;
  policyType: Fact<PolicyType>;
  businessType: Fact<BusinessType>;
  previousInsurer: Fact<string>;
  make: Fact<string>;
  model: Fact<string>;
  fuel: Fact<Fuel>;
  cngLpgKit: Fact<boolean>;
  cc: Fact<number>;
  seats: Fact<number>;
  manufactureYear: Fact<number>;
  registrationDate: Fact<string>; // ISO yyyy-mm-dd
  vehicleAgeYears: Fact<number>;
  registrationNumber: Fact<string>;
  rtoCode: Fact<string>; // normalised, e.g. HR-26, DL-9
  rtoLocation: Fact<string>;
  state: Fact<string>;
  ncbPercent: Fact<number>;
  covers: Fact<string[]>; // opted add-on covers (Nil Dep, RTI, ...) plus CPA when charged
  gwpSlab: Fact<string>; // broker's achieved business-volume slab; never printed on a policy, only a user answer
  policyStart: Fact<string>; // ISO
  policyEnd: Fact<string>; // ISO
  premium: PremiumFacts;
}

export type FactKey = Exclude<keyof PolicyFacts, 'premium'> | `premium.${keyof PremiumFacts}`;

export interface Citation {
  file: string; // path relative to repo root, e.g. raters/godigit/march-2026/...xlsx
  sheet?: string;
  cell?: string; // A1 reference or range
  page?: number; // PDF rate cards
  table?: string; // PDF table label
  row?: string; // human row label
  column?: string; // human column label
  value: string | number | null;
  label: string; // why this cell matters
}

export type Applicability = 'applicable' | 'not_applicable' | 'unsupported' | 'ambiguous';

export interface RateCandidate {
  ratePercent: number;
  assumption: string;
  citations: Citation[];
}

export interface RateComponent {
  applicability: Applicability;
  ratePercent: number | null;
  appliesTo: string; // premium component the rate applies to
  premiumBase: number | null; // rupee base, when extracted
  expectedBrokerage: number | null; // rupees = base * rate, rounded to paise
  reason: string;
  citations: Citation[];
  candidates?: RateCandidate[];
}

export type ResultStatus = 'resolved' | 'ambiguous' | 'unsupported';

export interface TraceStep {
  title: string;
  detail: string;
  citations?: Citation[];
  outcome?: 'ok' | 'warn' | 'stop';
}

export interface ClarifyingQuestion {
  fact: FactKey;
  question: string;
  options?: { value: string; label: string }[];
}

export interface RateResult {
  status: ResultStatus;
  insurer: InsurerId | null;
  grid: { file: string; label: string; effective: string } | null;
  od: RateComponent;
  tp: RateComponent;
  confidence: { level: 'high' | 'medium' | 'low'; reason: string };
  summary: string;
  trace: TraceStep[];
  questions: ClarifyingQuestion[];
}

export interface AnalysisResult {
  engineVersion: string;
  analysedAt: string;
  facts: PolicyFacts;
  result: RateResult;
}

/** User answers to clarifying questions / fact corrections, keyed by FactKey. */
export type FactOverrides = Partial<Record<FactKey, string | number | boolean | null>>;
