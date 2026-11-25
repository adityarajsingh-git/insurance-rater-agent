// Build-time normaliser for the Go Digit Mar'26 workbook (spec: godigit.md section 5).
// Reads only the private-car tables ('4W SATP', '4W  RTO', '4W New Business 1+3') plus the
// 'CV RTO Mapping' city/state columns used to cross-check the printed RTO location, and
// writes src/data/grids/godigit.json. Every structural assumption is asserted: if the
// workbook changes shape, the build throws instead of drifting.
// Run: npx tsx scripts/grids/godigit.ts
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import XLSX from 'xlsx';
import type { GodigitGrid, GridFuel, NewBusinessRow, NoteRule, SatpCluster, SatpRow } from '../../src/core/insurers/godigit/grid';
import { toPercent } from '../../src/core/insurers/module';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
export const SOURCE = "raters/godigit/march-2026/Large Insurance Brokers Mar'26 - Shared.xlsx";
export const OUT = 'src/data/grids/godigit.json';

const SATP = '4W SATP';
const RTO = '4W  RTO'; // two spaces, as in the workbook
const NB = '4W New Business 1+3';
const CV = 'CV RTO Mapping';
const BUS = 'School & Staff Bus '; // trailing space, as in the workbook

/** '4W  RTO'!C values whose '4W SATP' label differs by more than case (spec section 3.2). */
const ALIASES: Record<string, string[]> = {
  'AP TS_GOOD1': ['AP TS_GOOD1/GOOD2', 'AP TS_GOOD1'],
  'AP TS_GOOD2': ['AP TS_GOOD1/GOOD2', 'AP TS_GOOD2'],
  DELHI: ['DELHI/NCR', 'DELHI'],
  NCR: ['DELHI/NCR', 'NCR'],
  JH_GOOD: ['JH_BAD/JH_GOOD', 'JH_GOOD'],
  JH_BAD: ['JH_BAD/JH_GOOD', 'JH_BAD'],
};

/** Blocks no RTO maps to (spec section 6.4): normalised, never selected. */
const ORPHAN_ROWS = [127, 128, 129, 130, 131, 132, 324, 325, 326, 327, 328];

/** Column-F notes as rules (spec section 3.6). Each applies to its cluster, not just its row. */
const NOTES: NoteRule[] = [
  // Sits on a Petrol<1000 row but describes cars above 1500 cc.
  { cell: 'F27', text: 'More than 1500CC and 10+age is declined', clusters: ['AP TS_GOOD1'], fuel: 'Petrol', ccMin: 1501, ccMax: null, age: '>10', effect: 'declined' },
  { cell: 'F67', text: 'Few RTOs for 10+ age are declined', clusters: ['DELHI', 'NCR'], fuel: 'Diesel', ccMin: 0, ccMax: 1500, age: '>10', effect: 'some_rtos_declined' },
  { cell: 'F68', text: 'Few RTOs for all age are declined', clusters: ['DELHI'], fuel: 'Diesel', ccMin: 1501, ccMax: null, age: null, effect: 'some_rtos_declined' },
  { cell: 'F69', text: 'Few RTOs for all age are declined', clusters: ['NCR'], fuel: 'Diesel', ccMin: 1501, ccMax: null, age: null, effect: 'some_rtos_declined' },
  { cell: 'F70', text: 'Few RTOs for <10 age are declined', clusters: ['DELHI', 'NCR'], fuel: 'Petrol', ccMin: 0, ccMax: 1000, age: '<10', effect: 'some_rtos_declined' },
  { cell: 'F120', text: '1000-1500CC and <10 age is declined', clusters: ['HR_BAD'], fuel: 'Petrol', ccMin: 1001, ccMax: 1500, age: '<10', effect: 'declined' },
  { cell: 'F163', text: '1000-1500CC and <10 age is declined', clusters: ['KERALA'], fuel: 'Petrol', ccMin: 1001, ccMax: 1500, age: '<10', effect: 'declined' },
  { cell: 'F180', text: 'Few RTOs for 1000-1500CC segment are declined', clusters: ['MUMBAI'], fuel: 'CNG', ccMin: 1001, ccMax: 1500, age: null, effect: 'some_rtos_declined' },
  { cell: 'F244', text: 'Few RTOs for more than 1500CC and 10+age are declined', clusters: ['RJ_GOOD'], fuel: 'Petrol', ccMin: 1501, ccMax: null, age: '>10', effect: 'some_rtos_declined' },
  // On the orphan 'Mumbai 2' block: kept so a text change fails the build, never reached.
  { cell: 'F324', text: 'Few RTOs for 1000-1500CC segment are declined', clusters: [], fuel: 'CNG', ccMin: 1001, ccMax: 1500, age: null, effect: 'some_rtos_declined' },
];

function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`godigit grid: ${msg}`);
}

const key = (s: string) => s.trim().toUpperCase();

function reader(wb: XLSX.WorkBook, sheet: string) {
  const ws = wb.Sheets[sheet];
  check(ws, `sheet '${sheet}' is missing`);
  const v = (a: string): string | number | undefined => {
    const c = ws[a] as XLSX.CellObject | undefined;
    return typeof c?.v === 'string' || typeof c?.v === 'number' ? c.v : undefined;
  };
  const text = (a: string) => {
    const x = v(a);
    return x === undefined ? '' : String(x);
  };
  const expect = (a: string, want: string | number) => check(v(a) === want, `'${sheet}'!${a} should be ${JSON.stringify(want)}, got ${JSON.stringify(v(a))}`);
  return { ws, v, text, expect };
}

/** '4W SATP'!C label -> fuel + cc band (IRDAI TP slabs, spec section 3.3). */
function parseSegment(label: string): [GridFuel, number, number | null] {
  const m = label.match(/^(CNG|Diesel|Petrol)\s*(.*)$/);
  check(m, `unparseable segment '${label}'`);
  const fuel = m[1] as GridFuel;
  const rest = m[2].replace(/\s/g, '');
  if (!rest) return [fuel, 0, null];
  let r = rest.match(/^<(\d+)$/);
  if (r) return [fuel, 0, Number(r[1])];
  r = rest.match(/^>(\d+)$/);
  if (r) return [fuel, Number(r[1]) + 1, null];
  r = rest.match(/^(\d+)-(\d+)$/);
  check(r, `unparseable cc band in '${label}'`);
  return [fuel, Number(r[1]) + 1, Number(r[2])];
}

function readRto(wb: XLSX.WorkBook): GodigitGrid['rto'] {
  const s = reader(wb, RTO);
  ['RTO Code', '4WTP', '4W Package', '4WSAOD', 'PLR Cluster'].forEach((h, i) => s.expect(`${'BCDEF'[i]}2`, h));
  s.expect('B1609', 'UP78');
  s.expect('C1609', 'UP_Bad');
  const out: GodigitGrid['rto'] = {};
  for (let r = 3; s.text(`B${r}`); r++) {
    const code = s.text(`B${r}`).trim();
    const [tp, pkg, saod] = ['C', 'D', 'E'].map((c) => s.text(`${c}${r}`).trim());
    check(/^[A-Z]{2}(\d{2}|\d[A-Z])$/.test(code), `'${RTO}'!B${r} '${code}' is not an RTO code`);
    check(!out[code], `'${RTO}'!B${r} duplicates ${code}`);
    check(tp && pkg, `'${RTO}'!C${r}:D${r} blank`);
    check(pkg === saod, `'${RTO}'!D${r} and E${r} differ`);
    out[code] = [r, tp, pkg];
  }
  check(Object.keys(out).length === 1722, `'${RTO}' should have 1722 codes, has ${Object.keys(out).length}`);
  return out;
}

function readCvRto(wb: XLSX.WorkBook, rto: GodigitGrid['rto']): GodigitGrid['cvRto'] {
  const s = reader(wb, CV);
  s.expect('A2', 'RTO Code');
  s.expect('B2', 'State');
  check(s.text('C2').trim() === 'City', `'${CV}'!C2 should be 'City'`);
  s.expect('A1807', 'UP78');
  const out: GodigitGrid['cvRto'] = {};
  const last = XLSX.utils.decode_range(s.ws['!ref'] ?? 'A1').e.r + 1;
  for (let r = 3; r <= last; r++) {
    const code = s.text(`A${r}`).trim();
    if (rto[code] && !out[code]) out[code] = [r, s.text(`B${r}`).trim(), s.text(`C${r}`).trim()];
  }
  return out;
}

function readSatp(wb: XLSX.WorkBook): SatpRow[] {
  const s = reader(wb, SATP);
  ['Cluster', 'Segment', 'Age', 'Max CD2', 'Note'].forEach((h, i) => s.expect(`${'BCDEF'[i]}2`, h));
  // The sample policy's decisive cells (spec section 4).
  s.expect('B293', 'UP_Bad');
  s.expect('C293', 'Petrol>1000');
  s.expect('D293', 'All');
  s.expect('E293', 0.295);
  const rows: SatpRow[] = [];
  for (let r = 3; r <= 328; r++) {
    const [cluster, segment, age, note] = ['B', 'C', 'D', 'F'].map((c) => s.text(`${c}${r}`));
    const raw = s.v(`E${r}`);
    check(cluster.trim(), `'${SATP}'!B${r} blank`);
    check(typeof raw === 'number' && raw >= 0 && raw <= 1, `'${SATP}'!E${r} is not a rate in [0, 1]`);
    check(age === 'All' || age === '<10' || age === '>10', `'${SATP}'!D${r} age '${age}'`);
    const [fuel, ccMin, ccMax] = parseSegment(segment);
    rows.push({
      row: r, cluster, segment, fuel, ccMin, ccMax, age, raw, pct: toPercent(raw, true),
      ...(note ? { note } : {}),
      ...(ORPHAN_ROWS.includes(r) ? { orphan: true as const } : {}),
    });
  }
  check(!s.text('B329'), `'${SATP}' has rows past 328`);
  return rows;
}

function checkNotes(rows: SatpRow[]): void {
  const inSheet = rows.filter((x) => x.note).map((x) => `F${x.row}`);
  check(inSheet.join() === NOTES.map((n) => n.cell).join(), `'${SATP}' note cells changed: ${inSheet.join()}`);
  for (const n of NOTES) {
    const row = rows.find((x) => `F${x.row}` === n.cell);
    check(row?.note === n.text, `'${SATP}'!${n.cell} text changed: ${JSON.stringify(row?.note)}`);
  }
}

function satpClusters(rows: SatpRow[], rto: GodigitGrid['rto']): Record<string, SatpCluster> {
  const out: Record<string, SatpCluster> = {};
  for (const [, tp] of Object.values(rto)) {
    const k = key(tp);
    if (out[k]) continue;
    const labels = ALIASES[k] ?? [k];
    const hit = rows.filter((x) => !x.orphan && labels.includes(key(x.cluster)));
    check(hit.length, `'${RTO}'!C value '${tp}' matches no '${SATP}' row`);
    out[k] = { labels: [...new Set(hit.map((x) => x.cluster))], rows: hit.map((x) => x.row) };
  }
  for (const [k, labels] of Object.entries(ALIASES)) {
    for (const l of labels) check(rows.some((x) => key(x.cluster) === l), `alias ${k} -> '${l}' matches no row`);
  }
  const used = new Set(Object.values(out).flatMap((c) => c.rows));
  const orphans = rows.filter((x) => !used.has(x.row)).map((x) => x.row);
  check(orphans.join() === ORPHAN_ROWS.join(), `orphan rows changed: ${orphans.join()}`);
  return out;
}

function readNewBusiness(wb: XLSX.WorkBook, rto: GodigitGrid['rto']): GodigitGrid['newBusiness'] {
  const s = reader(wb, NB);
  const merges = (s.ws['!merges'] ?? []).map((m) => XLSX.utils.encode_range(m));
  check(merges.includes('B2:H2') && merges.includes('I2:I3'), `'${NB}' merged headers moved: ${merges.join()}`);
  s.expect('B2', 'CD2 for New Business 1+3');
  s.expect('I2', '3+3 (Payable over 3 Yrs)');
  s.expect('A3', 'Cluster');
  const makes: Record<string, string[]> = {};
  for (const c of 'BCDEFGH') makes[c] = s.text(`${c}3`).split(',').map((m) => m.trim().replace(/^HEV-/, ''));
  check(makes.B.join() === 'Tata' && makes.E.join() === 'Hyundai' && makes.H.includes('Others'), `'${NB}' make header moved`);
  check(s.text('G3').startsWith('HEV-'), `'${NB}'!G3 no longer starts with HEV-`);
  makes.G.push('Citroen'); // G3 spells it 'Citrone'
  const rows: Record<string, NewBusinessRow> = {};
  for (let r = 4; r <= 31; r++) {
    const label = s.text(`A${r}`).trim();
    const rates: Record<string, number> = {};
    for (const c of 'BCDEFGHI') {
      const x = s.v(`${c}${r}`);
      check(typeof x === 'number' && x >= 0 && x <= 1, `'${NB}'!${c}${r} is not a rate`);
      rates[c] = x;
    }
    rows[key(label)] = { row: r, label, rates };
  }
  const pkg = new Set(Object.values(rto).map(([, , p]) => key(p)));
  check(pkg.size === 28 && [...pkg].every((p) => rows[p]), `'${RTO}'!D clusters and '${NB}'!A4:A31 differ`);
  return {
    header: [
      { cell: 'B2', value: s.text('B2'), columns: 'B:H' },
      { cell: 'I2', value: s.text('I2'), columns: 'I' },
    ],
    makes,
    rows,
  };
}

export function build(): GodigitGrid {
  const buf = readFileSync(join(ROOT, SOURCE));
  const wb = XLSX.read(buf, { cellFormula: false, cellStyles: true });
  const bus = reader(wb, BUS);
  bus.expect('B2', 'Applicable from 1st of Mar, 2026');
  const cvGrid = reader(wb, 'CV Grid (excl. HCV)');
  cvGrid.expect('G2', 'Digit_FY 25-26 SATP');

  const rto = readRto(wb);
  const rows = readSatp(wb);
  checkNotes(rows);
  return {
    source: {
      file: SOURCE,
      sha256: createHash('sha256').update(buf).digest('hex'),
      sheets: [SATP, RTO, NB, CV],
      effective: {
        from: '2026-03-01',
        to: '2026-03-31',
        label: "March 2026 (Mar'26 workbook; no end date is stated, so 1-31 Mar 2026 is assumed)",
        evidence: [
          { sheet: BUS, cell: 'B2', value: bus.text('B2') },
          { sheet: 'CV Grid (excl. HCV)', cell: 'G2', value: cvGrid.text('G2') },
        ],
      },
    },
    rto,
    cvRto: readCvRto(wb, rto),
    satp: {
      header: ['B2', 'C2', 'D2', 'E2', 'F2'].map((a) => reader(wb, SATP).text(a)),
      rows,
      clusters: satpClusters(rows, rto),
    },
    notes: NOTES,
    newBusiness: readNewBusiness(wb, rto),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = join(ROOT, OUT);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(build())}\n`);
  console.log(`wrote ${OUT}`);
}
