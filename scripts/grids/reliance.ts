// Build-time normaliser for the Reliance General (IndusInd) private-car grid (semantics: specs/reliance.md).
// Reads the private-car sheet, the PC STP Non-Diesel block of the FEB'26 sheet, the RTO List and the
// hygiene rules, and writes src/data/grids/reliance.json. Every value keeps its sheet and cell so the
// resolver can cite it. Run: npx tsx scripts/grids/reliance.ts. Throws when the workbook drifts from the spec.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';
import type { RelianceGrid } from '../../src/core/insurers/reliance/grid';

export const SOURCE = 'raters/reliance-indusind/feb-2026/Reliance Broking Premier  FEB 26 Grid.xlsx';
export const OUTPUT = 'src/data/grids/reliance.json';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const PC = 'PRIVATE CAR COMP, SAOD & STP';
const MAIN = "FEB'26 - Grid";
const RTO = 'RTO List';
const ENB = 'Enabler, PO Guidelines & T&C';
const SKIPPED = ['TW SCOOTER GRID', 'Short Term Taxi', 'Contest', 'Make Model wise segment'];

/** Exact text the spec relies on; a changed header or footnote must break the build. */
const PC_TEXT: Record<string, string> = {
  A1: 'Pvt Car Old Business Grid- Jan-26',
  A2: 'Zone',
  B2: 'RTO region',
  C2: 'Petrol/Bifuel/Comp',
  D2: 'Diesel/EV/Comp',
  E2: 'SA OD',
  F2: 'STP',
  H1: 'Terms & Conditions',
  H2: 'payout will made on OD Premium',
  H3: 'Payout for < 1000 CC, PO will be 5% lesser than the above Grid',
  H4: 'Standlone ZD policies 2.5%will be redused from the above Grid',
  H5: 'EW of Pvivate car will be Flat 20% Payout',
  H6: 'Addon Bundle (Tyre / RTI) if Sourced, 2.5% Additional Payout Shall be offered',
};

const MAIN_TEXT: Record<string, string> = {
  A1: "PO Grid for FEB '26 FY 25-26",
  AR2: 'PC STP Non-Diesel',
  AR3: '<1000CC',
  AS3: '1000 CC-1500 CC',
  AT3: '>1500 CC',
  AR4: 'All Makes',
  AS4: 'All Makes',
  AT4: 'All Makes',
};

/** PC row -> label in column B and the RTO!C Region_City values grouped under it (spec section 3, step 3). */
const PC_ROWS: [number, string, string[]][] = [
  [3, 'Mumbai, Pune, Goa', ['Mumbai', 'Pune', 'Goa']],
  [4, 'Rest Of Maharashtra', ['Rom', 'Nagpur', 'Ahmednagar', 'Aurangabad', 'Kolhapur', 'Nashik', 'Solapur']],
  [5, 'Gujrat', ['Ahmedabad', 'Surat', 'Vadodara', 'Gandhidham', 'Jamnagar', 'Rajkot', 'Vapi', 'Guj 1']],
  [6, 'Madhya Pradesh', ['Madhya Pradesh']],
  [7, 'Banglore, Hyderabad', ['Bangalore', 'Hyderabad']],
  [8, 'rest of KA,TS,AP', ['Karnataka', 'Mangalore', 'Mysore', 'Telangana', 'Andhra Pradesh']],
  [9, 'Kerala', ['Kerala', 'Calicut', 'Cochin', 'Thiruvananthapuram']],
  [10, 'TamilNadu', ['Tamilnadu', 'Chennai', 'Coimbatore', 'Erode', 'Madurai', 'Pondicherry']],
  [11, 'Delhi', ['Delhi']],
  [12, 'Punjab, HP , JK', ['Punjab', 'PUNJAB', 'Amritsar', 'Ludhiana', 'Hp And Jammu', 'Jammu', 'Shimla', 'Srinagar', 'Ladakh']],
  [13, 'UP, Haryana , Rajasthan', ['Up1', 'Up2', 'Lucknow', 'Varanasi', 'Haryana', 'Rajasthan', 'Jaipur', 'Uttarakhand', 'Dehradun']],
  [14, 'NE , Odisha, Chhattisgarh', ['North East', 'Agartala', 'Aizwal', 'Guwahati', 'Odisha', 'Bhubaneshwar', 'Cuttack', 'Rourkela', 'Chhattisgarh']],
  [15, 'Bihar , Jharkhand', ['Bihar', 'Patna', 'Jharkhand', 'Jamshedpur', 'Ranchi']],
  [16, 'Kolkata', ['Kolkata']],
  [17, 'West Bengal', ['West Bengal', 'Siliguri']],
];

/** Cities that are not named on the PC sheet: grouping inferred from the FEB'26 sheet (warn) or genuinely open. */
const CITY_NOTES: Record<string, { rows?: number[]; note: string }> = {
  Chandigarh: {
    rows: [12, 13],
    note: "Chandigarh is not on the private-car sheet; FEB'26!C42 treats it as its own region, so it could sit under row 12 (Punjab, HP , JK) or row 13 (UP, Haryana , Rajasthan)",
  },
  Pondicherry: { note: "Pondicherry is not named on the private-car sheet; grouped under TamilNadu as FEB'26!B40:C40 does" },
  Ladakh: { note: "Ladakh is not named on the private-car sheet; grouped under Punjab, HP , JK as FEB'26!B47:C47 (HP AND JAMMU / LEH & LAHDHK) does, although RTO List!E says EAST" },
  Uttarakhand: { note: "Uttarakhand is not named on the private-car sheet; grouped under UP as FEB'26!B54:C59 (UP East / UP & UTTARAKHAND) does" },
  Dehradun: { note: "Dehradun is not named on the private-car sheet; grouped under UP as FEB'26!B54:C59 (UP East / UP & UTTARAKHAND) does" },
};

/** RTO!C value -> FEB'26!C value where the spelling differs. */
const MAIN_ALIASES: Record<string, string> = { thiruvananthapuram: 'TRIVANDRUM', ladakh: 'LEH & LAHDHK' };

const HYGIENE_CELLS = ['A44', 'A45', 'A46', 'A47', 'A48'];

function check(ok: unknown, msg: string): asserts ok {
  if (!ok) throw new Error(`reliance grid: ${msg}`);
}

function sheet(wb: XLSX.WorkBook, name: string): XLSX.WorkSheet {
  const ws = wb.Sheets[name];
  check(ws, `sheet "${name}" is missing`);
  return ws;
}

const val = (ws: XLSX.WorkSheet, cell: string): unknown => ws[cell]?.v;

function text(ws: XLSX.WorkSheet, cell: string): string {
  const v = val(ws, cell);
  check(typeof v === 'string', `${cell} is not text`);
  return v.trim();
}

function num(ws: XLSX.WorkSheet, cell: string): number {
  const v = val(ws, cell);
  check(typeof v === 'number' && Number.isFinite(v), `${cell} is not a number (${String(v)})`);
  return v;
}

function expectText(ws: XLSX.WorkSheet, name: string, expected: Record<string, string>): void {
  for (const [cell, want] of Object.entries(expected)) check(text(ws, cell) === want, `${name}!${cell} changed: "${String(val(ws, cell))}"`);
}

/** RTO code key: upper case, spaces and hyphens removed ("TN -68" -> "TN68"). */
export const rtoKey = (code: string): string => code.toUpperCase().replace(/[\s-]/g, '');

export function build(): RelianceGrid {
  const buf = readFileSync(ROOT + SOURCE);
  const wb = XLSX.read(buf, { cellFormula: false, cellStyles: true });
  check(wb.SheetNames.length === 8, `expected 8 sheets, found ${wb.SheetNames.length}`);
  for (const name of SKIPPED) sheet(wb, name); // present but not used for private cars

  // Private-car sheet: rates are whole percentages; zones are merged A-ranges.
  const pc = sheet(wb, PC);
  expectText(pc, PC, PC_TEXT);
  const merges = (pc['!merges'] ?? []).map((r) => XLSX.utils.encode_range(r));
  const zoneRanges: [string, number, number][] = [['A3:A6', 3, 6], ['A7:A10', 7, 10], ['A11:A13', 11, 13], ['A14:A17', 14, 17]];
  for (const [range] of zoneRanges) check(merges.includes(range), `${PC}!${range} is no longer merged`);
  const zoneOf = (row: number) => {
    const zone = zoneRanges.find(([, a, b]) => row >= a && row <= b);
    check(zone, `no zone for row ${row}`);
    return text(pc, `A${zone[1]}`);
  };
  const pcRows = PC_ROWS.map(([row, label]) => {
    check(text(pc, `B${row}`) === label, `${PC}!B${row} changed: "${String(val(pc, `B${row}`))}"`);
    return { row, zone: zoneOf(row), label, C: num(pc, `C${row}`), D: num(pc, `D${row}`), E: num(pc, `E${row}`), F: num(pc, `F${row}`) };
  });
  check(val(pc, 'B18') === undefined && val(pc, 'C18') === undefined, `${PC} has rows below 17`);

  // FEB'26 sheet: only the PC STP Non-Diesel block AR:AT; rates are fractions.
  const main = sheet(wb, MAIN);
  expectText(main, MAIN, MAIN_TEXT);
  check((main['!merges'] ?? []).some((r) => XLSX.utils.encode_range(r) === 'AR2:AT2'), `${MAIN}!AR2:AT2 is no longer merged`);
  const mainRows: RelianceGrid['main']['rows'] = {};
  const mainByRegion = new Map<string, number>();
  for (let row = 5; row <= 76; row++) {
    const region = text(main, `C${row}`);
    mainRows[row] = { zone: text(main, `A${row}`), cluster: text(main, `B${row}`), region, AR: num(main, `AR${row}`), AS: num(main, `AS${row}`), AT: num(main, `AT${row}`) };
    mainByRegion.set(region.toUpperCase(), row);
  }
  check(val(main, 'C77') === undefined, `${MAIN} has region rows below 76`);

  // RTO List: key on column A only (column B is lossy). Dedupe a key only when Region_City agrees.
  const rto = sheet(wb, RTO);
  expectText(rto, RTO, { A1: 'Region_Code', B1: 'Column1', C1: 'Region_City', D1: 'Market_Type', E1: 'Zone' });
  check(rto['!ref'] === 'A1:E1502', `${RTO} range changed: ${rto['!ref']}`);
  const codes: RelianceGrid['rto']['codes'] = {};
  const cityByRow = new Map(PC_ROWS.flatMap(([row, , cities]) => cities.map((c) => [c, row] as const)));
  const regions: RelianceGrid['regions'] = {};
  for (let row = 2; row <= 1502; row++) {
    const code = String(val(rto, `A${row}`) ?? '').trim();
    const city = text(rto, `C${row}`);
    check(code, `${RTO}!A${row} is blank`);
    const key = rtoKey(code);
    const prev = codes[key];
    if (prev) check(prev[2] === city, `${RTO} key ${key} maps to both ${prev[2]} and ${city}`);
    else codes[key] = [row, code, city];
    if (regions[city]) continue;
    const pcRow = cityByRow.get(city);
    const extra = CITY_NOTES[city];
    check(pcRow || extra?.rows, `${RTO}!C${row} "${city}" has no private-car row in the alias table`);
    const mainRow = mainByRegion.get((MAIN_ALIASES[city.toLowerCase()] ?? city).toUpperCase());
    check(mainRow, `${RTO}!C${row} "${city}" has no ${MAIN} row`);
    regions[city] = { pcRows: extra?.rows ?? [pcRow!], mainRow, ...(extra ? { note: extra.note } : {}) };
  }

  const enb = sheet(wb, ENB);
  const hygiene = Object.fromEntries(HYGIENE_CELLS.map((c) => [c, text(enb, c)]));
  check(hygiene.A47.startsWith('3.CPA is mandatory'), `${ENB}!A47 changed`);

  // The sample's decisive cells (spec section 4); a change here must be looked at by a person.
  check(codes.UP16?.[0] === 1253 && codes.UP16[2] === 'Delhi', `${RTO}!A1253 no longer maps UP-16 to Delhi`);
  check(regions.Delhi.pcRows[0] === 11 && regions.Delhi.mainRow === 41, 'Delhi no longer maps to PC row 11 / FEB row 41');
  check(num(pc, 'C11') === 22.5 && num(pc, 'D11') === 10 && num(pc, 'F11') === 0, `${PC}!C11/D11/F11 changed`);
  check(num(main, 'AR41') === 0 && text(main, 'C41') === 'DELHI', `${MAIN}!AR41 changed`);

  return {
    source: {
      file: SOURCE,
      sha256: createHash('sha256').update(buf).digest('hex'),
      sheets: wb.SheetNames,
      skipped: SKIPPED,
      effective: { from: '2026-02-01', to: '2026-02-28', label: `FEB '26 (${MAIN}!A1); the private-car sheet title ${PC}!A1 says Jan-26` },
    },
    pc: { sheet: PC, text: PC_TEXT, rows: pcRows },
    main: { sheet: MAIN, text: MAIN_TEXT, rows: mainRows },
    regions,
    rto: { sheet: RTO, codes },
    hygiene: { sheet: ENB, rules: hygiene },
  };
}

/** Pretty JSON with every flat object or array on one line (one grid row / RTO code per line). */
export function render(grid: RelianceGrid): string {
  const flat = /([{[])\n\s+([^{}[\]]*?)\n\s+([}\]])/g;
  return `${JSON.stringify(grid, null, 2).replace(flat, (_, open, body: string, close) => `${open}${body.replace(/\n\s+/g, ' ')}${close}`)}\n`;
}

if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(ROOT + OUTPUT, render(build()));
  console.log(`wrote ${OUTPUT}`);
}
