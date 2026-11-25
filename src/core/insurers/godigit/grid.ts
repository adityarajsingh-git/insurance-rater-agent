// Shape of src/data/grids/godigit.json, written by scripts/grids/godigit.ts from the Go Digit
// Mar'26 workbook. Every rate keeps its sheet row so the resolver can cite the exact cell.

export type GridFuel = 'Petrol' | 'Diesel' | 'CNG';
export type AgeBand = '<10' | '>10';

/** One '4W SATP' row: B cluster, C segment, D age, E Max CD2 (TP rate), F note. */
export interface SatpRow {
  row: number;
  cluster: string; // raw B
  segment: string; // raw C
  fuel: GridFuel;
  ccMin: number;
  ccMax: number | null; // null = no upper bound
  age: AgeBand | 'All';
  raw: number; // raw E value (a fraction, formatted 0.0%)
  pct: number; // E as a percent, float noise removed
  note?: string; // raw F
  orphan?: true; // no '4W  RTO' cluster maps to this row
}

/** A column-F note encoded as a rule; it applies to its whole cluster, not just its own row. */
export interface NoteRule {
  cell: string; // e.g. F120
  text: string;
  clusters: string[]; // '4W  RTO'!C values (upper-case) the note covers
  fuel: GridFuel | null;
  ccMin: number;
  ccMax: number | null;
  age: AgeBand | null;
  effect: 'declined' | 'some_rtos_declined';
}

/** '4W  RTO'!C value (upper-cased) -> the '4W SATP' labels and rows it selects. */
export interface SatpCluster {
  labels: string[];
  rows: number[];
}

export interface NewBusinessRow {
  row: number;
  label: string; // raw A
  rates: Record<string, number>; // column letter (B..I) -> raw fraction
}

export interface GodigitGrid {
  source: {
    file: string;
    sha256: string;
    sheets: string[];
    effective: { from: string; to: string; label: string; evidence: { sheet: string; cell: string; value: string }[] };
  };
  /** RTO code -> [row, 4WTP cluster (C), 4W Package cluster (D)] from '4W  RTO'. */
  rto: Record<string, [number, string, string]>;
  /** RTO code -> [row, state (B), city (C)] from 'CV RTO Mapping', for codes in '4W  RTO'. */
  cvRto: Record<string, [number, string, string]>;
  satp: { header: string[]; rows: SatpRow[]; clusters: Record<string, SatpCluster> };
  notes: NoteRule[];
  newBusiness: {
    header: { cell: string; value: string; columns: string }[];
    makes: Record<string, string[]>; // column letter -> make names (G/H split on commas)
    rows: Record<string, NewBusinessRow>; // upper-case cluster -> row
  };
}
