// Build-time normaliser for the Tata AIG private-car grid (semantics: specs/tata-aig.md).
// Reads every Pvtcar rate cell - including the 308 rows the saved AutoFilter hides - plus the
// rule cells the resolver cites, and writes src/data/grids/tata-aig.json.
// Run: npx tsx scripts/grids/tata-aig.ts. Throws when the workbook layout drifts from the spec.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';

export const SOURCE = "raters/tata-aig/march-2026/Tata AIG Standard Grid_Communication_Mar'26_F_v2_0212.xlsx";
export const OUTPUT = 'src/data/grids/tata-aig.json';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const SHEET = 'Pvtcar';
const FIRST_ROW = 6;
const LAST_ROW = 565; // 566 is empty, 567 holds SUBTOTAL checksums
const FIRST_COL = XLSX.utils.decode_col('M');
const LAST_COL = XLSX.utils.decode_col('BO');

const DIMENSIONS = [
  ['G', 'segment', 'Type'],
  ['H', 'businessType', 'Business Type'],
  ['I', 'fuel', 'Fuel Type'],
  ['J', 'section', 'Section Text'],
  ['K', 'ncb', 'NCB'],
  ['L', 'addOn', 'Add On'],
] as const;

type DimensionKey = (typeof DIMENSIONS)[number][1];

const EXPECTED_VALUES: Record<DimensionKey, string[]> = {
  segment: ['Compact', 'High End', 'MPV SUV', 'Mid Size', 'Mini', 'Quadricycle', 'Ultra High End'],
  businessType: ['Brand New', 'Renewal', 'Rollover'],
  fuel: ['CNG', 'Diesel', 'Electric', 'Other Than Diesel'],
  section: ['Package', 'SAOD', 'SATP'],
  ncb: ['All', 'No', 'Yes'],
  addOn: ['All', 'No', 'Yes'],
};

// Cells whose text the resolver quotes: premium basis, base-only caveat, LTTP, RTO and deal-sequence rules.
const NOTE_CELLS = [
  'Pvtcar!F1', 'Pvtcar!F2', 'Pvtcar!F3',
  ...[5, 7, 9, 10, 11, 12, 13, 14, 15, 16, 17].map((r) => `General Guidelines!C${r}`),
];

// Exact header strings the resolver and its tests depend on (spec §3.0, §3.7).
const EXPECTED_TEXT: Record<string, string> = {
  'Pvtcar!F1': "Standard Grid for Pvt Car LOB to be applicable from 1st Nov'25 policies",
  'Pvtcar!F2': 'Package/SAOD % on OD Premium; SATP % on Net Premium',
  'Pvtcar!M5': 'AHMEDABAD',
  'Pvtcar!V5': 'DELHI',
  'Pvtcar!X5': 'HARYANA',
  'Pvtcar!BO5': 'ROWB2',
  'General Guidelines!C7': 'Payout % for Pvt Car- SATP on Net Premium; Package and SAOD on OD premium',
  'General Guidelines!C9': 'LTTP not be considered for premium slab as well as payout %',
};

export interface GridRow {
  row: number;
  segment: string;
  businessType: string;
  fuel: string;
  section: string;
  ncb: string;
  addOn: string;
  rates: number[]; // one per location, same order as `locations`; fractions rounded to 6 dp
}

export interface TataGrid {
  source: {
    file: string;
    sha256: string;
    sheets: string[];
    effective: { from: string; to: string | null; label: string };
  };
  notes: Record<string, string>;
  locations: { col: string; name: string; tag: string }[];
  rows: GridRow[];
}

function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`tata-aig grid drifted from the spec: ${message}`);
}

export function build(): TataGrid {
  const path = ROOT + SOURCE;
  const wb = XLSX.readFile(path, { cellFormula: false, cellStyles: true });
  const cellAt = (ref: string): XLSX.CellObject | undefined => {
    const [sheet, addr] = ref.split('!');
    return wb.Sheets[sheet]?.[addr];
  };
  const text = (ref: string) => String(cellAt(ref)?.v ?? '').trim();

  for (const [ref, want] of Object.entries(EXPECTED_TEXT)) check(text(ref) === want, `${ref} = "${text(ref)}"`);
  for (const [col, , header] of DIMENSIONS) check(text(`${SHEET}!${col}5`) === header, `${col}5 header`);

  const ws = wb.Sheets[SHEET];
  // The saved AutoFilter (J = Package) hides every SATP/SAOD row; SheetJS still returns those cells.
  check((ws['!rows'] ?? []).filter((r) => r?.hidden).length === 308, 'expected 308 AutoFilter-hidden rows');
  check(ws[`G${LAST_ROW + 1}`] === undefined && ws[`G${LAST_ROW + 3}`] === undefined && ws[`M${LAST_ROW + 2}`] !== undefined,
    'data must end at row 565 with the SUBTOTAL row at 567');

  const locations: TataGrid['locations'] = [];
  for (let c = FIRST_COL; c <= LAST_COL; c++) {
    const col = XLSX.utils.encode_col(c);
    locations.push({ col, name: text(`${SHEET}!${col}5`), tag: text(`${SHEET}!${col}4`) });
  }
  check(new Set(locations.map((l) => l.name.toLowerCase())).size === 55, '55 distinct location headers');

  const rows: GridRow[] = [];
  const keys = new Set<string>();
  for (let r = FIRST_ROW; r <= LAST_ROW; r++) {
    const dims = Object.fromEntries(DIMENSIONS.map(([col, key]) => [key, text(`${SHEET}!${col}${r}`)])) as Record<DimensionKey, string>;
    const key = DIMENSIONS.map(([, k]) => dims[k]).join('|');
    check(!keys.has(key), `duplicate key ${key} at row ${r}`);
    keys.add(key);
    const rates = locations.map(({ col }) => {
      const v = ws[`${col}${r}`]?.v;
      check(typeof v === 'number' && v >= 0 && v <= 0.45, `${col}${r} = ${String(v)} is not a rate in [0, 0.45]`);
      return Math.round(v * 1e6) / 1e6;
    });
    rows.push({ row: r, ...dims, rates });
  }

  check(rows.length * locations.length === 30800, 'expected 30,800 rate cells');
  for (const [col, key] of DIMENSIONS) {
    const seen = [...new Set(rows.map((x) => x[key]))].sort();
    check(JSON.stringify(seen) === JSON.stringify(EXPECTED_VALUES[key]), `${col} values ${seen.join(', ')}`);
  }
  const count = (section: string) => rows.filter((x) => x.section === section).length;
  check(count('SATP') === 84 && count('SAOD') === 224 && count('Package') === 252, 'section row counts');

  // Decisive cells of the sample policy and the documented traps (spec §3.7, §4, §6).
  const rate = (col: string, row: number) => rows[row - FIRST_ROW].rates[locations.findIndex((l) => l.col === col)];
  for (const r of [511, 515, 519, 523, 527, 531, 535]) check(rate('V', r) === 0.38, `V${r} should be 0.38`);
  check(rows.every((x) => rate('X', x.row) === 0), 'HARYANA (X) should be 0 on every row');
  check(rate('V', 510) === 0.19 && rate('V', 9) === 0.2 && rate('W', 510) === 0.27 && rate('W', 538) === 0.35, 'spot cells');
  check(rate('AW', 10) === 0.24, 'AW10 float noise should round to 0.24');

  const notes = Object.fromEntries(NOTE_CELLS.map((ref) => [ref, text(ref)]));
  check(Object.values(notes).every(Boolean), 'every note cell has text');

  return {
    source: {
      file: SOURCE,
      sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
      sheets: [SHEET, 'General Guidelines'],
      effective: {
        from: '2025-11-01',
        to: null,
        label: "Mar'26 communication; Pvtcar!F1: applicable from 1st Nov'25 policies, no end date published",
      },
    },
    notes,
    locations,
    rows,
  };
}

/** Pretty header, one grid row per line - compact but diffable. */
export function render(grid: TataGrid): string {
  const { rows, ...head } = grid;
  const body = rows.map((r) => `    ${JSON.stringify(r)}`).join(',\n');
  return `${JSON.stringify(head, null, 2).replace(/\n}$/, `,\n  "rows": [\n${body}\n  ]\n}`)}\n`;
}

if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(ROOT + OUTPUT, render(build()));
  console.log(`wrote ${OUTPUT}`);
}
