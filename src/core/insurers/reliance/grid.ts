// Shape of src/data/grids/reliance.json (written by scripts/grids/reliance.ts) and the typed import.
import data from '../../../data/grids/reliance.json';

export interface PcRow {
  row: number;
  zone: string; // display only, never a key
  label: string; // PC!B verbatim
  C: number; // Petrol/Bifuel/Comp, percent
  D: number; // Diesel/EV/Comp, percent
  E: number; // SA OD, percent
  F: number; // STP, percent
}

export interface MainRow {
  zone: string;
  cluster: string;
  region: string;
  AR: number; // PC STP Non-Diesel <1000CC, fraction
  AS: number; // 1000 CC-1500 CC, fraction
  AT: number; // >1500 CC, fraction
}

export interface RelianceGrid {
  source: {
    file: string;
    sha256: string;
    sheets: string[];
    skipped: string[];
    effective: { from: string; to: string; label: string };
  };
  pc: { sheet: string; text: Record<string, string>; rows: PcRow[] };
  main: { sheet: string; text: Record<string, string>; rows: Record<string, MainRow> };
  /** RTO!C Region_City -> PC rows (two when the grouping is open) and the FEB'26 row. */
  regions: Record<string, { pcRows: number[]; mainRow: number; note?: string }>;
  /** Normalised RTO code -> [RTO List row, code as printed in column A, Region_City]. */
  rto: { sheet: string; codes: Record<string, [number, string, string]> };
  hygiene: { sheet: string; rules: Record<string, string> };
}

export const grid = data as unknown as RelianceGrid;
