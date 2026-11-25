// Deterministic Go Digit private-car lookup (spec: godigit.md section 3).
// SATP: registration -> '4W  RTO' TP cluster -> '4W SATP' rows -> fuel x cc band x age band,
// then the column-F note rules. A fact that is missing or only partly known becomes a set of
// values; every combination is rated, and the component resolves only when all combinations
// agree. Otherwise it is ambiguous, with candidates and a question for each fact that matters.
import gridJson from '../../../data/grids/godigit.json';
import { squash, stateCodeFromName, stateFromCode } from '../../geo';
import type {
  Citation,
  ClarifyingQuestion,
  Fact,
  FactKey,
  PolicyFacts,
  RateCandidate,
  RateComponent,
  RateResult,
  TraceStep,
} from '../../types';
import { ambiguousComponent, buildResult, component, notApplicable, pct, unsupported } from '../module';
import type { AgeBand, GodigitGrid, GridFuel, NoteRule, SatpRow } from './grid';

const grid = gridJson as unknown as GodigitGrid;
const FILE = grid.source.file;
const SATP = '4W SATP';
const RTO = '4W  RTO'; // two spaces, as in the workbook
const NB = '4W New Business 1+3';
const CV = 'CV RTO Mapping';
const TP_BASE = 'Basic TP premium (Basic Third-Party Liability, excl. GST)';
const OD_BASE = 'OD premium';
const ZERO_WARNING = '0% CD2: this sheet uses 0 for declined combinations (E3:E8; E162 vs note F163); treat as no payout.';
const ROWS = new Map(grid.satp.rows.map((r) => [r.row, r]));

interface Ctx {
  trace: TraceStep[];
  doubts: string[]; // derived decisive facts and interpretation calls -> confidence
  questions: ClarifyingQuestion[];
}

const cite = (sheet: string, cell: string, value: string | number | null, label: string): Citation => ({ file: FILE, sheet, cell, value, label });

function step(ctx: Ctx, title: string, detail: string, outcome: TraceStep['outcome'], citations: Citation[] = []): void {
  ctx.trace.push({ title, detail, outcome, ...(citations.length ? { citations } : {}) });
}

function doubt(ctx: Ctx, label: string, f: Fact<unknown>): void {
  if (f.status === 'derived') ctx.doubts.push(`${label} was derived: ${f.note ?? 'inferred, not printed'}`);
}

function ask(ctx: Ctx, fact: FactKey, question: string, options?: ClarifyingQuestion['options']): void {
  if (!ctx.questions.some((q) => q.fact === fact)) ctx.questions.push({ fact, question, ...(options ? { options } : {}) });
}

const rupees = (n: number | null) => (n === null ? 'not read' : `Rs ${n.toFixed(2)}`);

function finish(ctx: Ctx, od: RateComponent, tp: RateComponent): RateResult {
  const n = ctx.doubts.length;
  const { from, to, label } = grid.source.effective;
  return buildResult({
    insurer: 'godigit',
    grid: { file: FILE, label: "Go Digit - Large Insurance Brokers grid, Mar'26", effective: `${from} to ${to} (${label})` },
    od,
    tp,
    confidence: {
      level: n === 0 ? 'high' : n === 1 ? 'medium' : 'low',
      reason: n === 0 ? 'Every decisive fact was printed and read cleanly, and the grid lookup needed no interpretation.' : `${ctx.doubts.join('; ')}.`,
    },
    trace: ctx.trace,
    questions: ctx.questions,
  });
}

function gridStep(ctx: Ctx, facts: PolicyFacts): void {
  const { from, to, label, evidence } = grid.source.effective;
  const cites = evidence.map((e) => cite(e.sheet, e.cell, e.value, 'Evidence for the effective period'));
  const start = facts.policyStart.value;
  const head = `Go Digit policy -> ${FILE} (sha256 ${grid.source.sha256.slice(0, 12)}). Effective ${from} to ${to}: ${label}.`;
  if (!start) step(ctx, 'Grid and validity', `${head} The policy start date is unknown, so validity was not checked.`, 'warn', cites);
  else if (start < from || start > to) step(ctx, 'Grid and validity', `${head} The policy starts ${start}, outside that window; resolved with this grid anyway, confirm the grid for that month.`, 'warn', cites);
  else step(ctx, 'Grid and validity', `${head} The policy starts ${start}, inside the window.`, 'ok', cites);
}

export function resolve(facts: PolicyFacts): RateResult {
  const ctx: Ctx = { trace: [], doubts: [], questions: [] };
  gridStep(ctx, facts);
  const type = facts.policyType;
  if (type.value === null) {
    const reason = `Policy type not determinable${type.note ? `: ${type.note}` : ''}. The sheet depends on it (SATP -> '4W SATP', new package -> '4W New Business 1+3').`;
    ask(ctx, 'policyType', 'Is this a stand-alone third-party (liability only), package/comprehensive or stand-alone own-damage policy?', [
      { value: 'satp', label: 'Stand-alone third party (liability only)' },
      { value: 'package', label: 'Package / comprehensive' },
      { value: 'saod', label: 'Stand-alone own damage' },
    ]);
    step(ctx, 'Policy type', reason, 'stop');
    return finish(ctx, ambiguousComponent(OD_BASE, reason, []), ambiguousComponent(TP_BASE, reason, []));
  }
  doubt(ctx, 'Policy type', type);
  if (type.value === 'satp') return satp(ctx, facts);
  if (type.value === 'saod') {
    const reason = "No 4W stand-alone OD grid in the Mar'26 workbook: '4W  RTO'!E (4WSAOD) maps clusters, but no sheet rates them.";
    const c = [cite(RTO, 'E2', '4WSAOD', 'SAOD cluster column, consumed by no sheet')];
    step(ctx, 'Sheet', reason, 'stop', c);
    return finish(ctx, unsupported(OD_BASE, reason, c), unsupported(TP_BASE, reason, c));
  }
  const business = facts.businessType;
  if (business.value === 'new') {
    doubt(ctx, 'Business type', business);
    return newBusiness(ctx, facts);
  }
  if (business.value) {
    const reason = `No 4W package grid for ${business.value} business in the Mar'26 workbook: '4W New Business 1+3' covers new cars only, and there is no 1+1 package sheet.`;
    const c = [cite(NB, 'B2', grid.newBusiness.header[0].value, 'The only private-car package sheet: new business')];
    step(ctx, 'Sheet', reason, 'stop', c);
    return finish(ctx, unsupported(OD_BASE, reason, c), unsupported(TP_BASE, reason, c));
  }
  const reason = "Business type unknown: a new car uses '4W New Business 1+3', a renewal or rollover package has no grid.";
  ask(ctx, 'businessType', 'Is this package policy for a new car, a renewal with Go Digit, or a rollover from another insurer?', [
    { value: 'new', label: 'New car' },
    { value: 'renewal', label: 'Renewal (previous insurer Go Digit)' },
    { value: 'rollover', label: 'Rollover (previous insurer another company)' },
  ]);
  step(ctx, 'Business type', reason, 'stop');
  return finish(ctx, ambiguousComponent(OD_BASE, reason, []), ambiguousComponent(TP_BASE, reason, []));
}

// ---------- geography ----------

interface RtoHit {
  code: string;
  row: number;
  tp: string; // '4W  RTO'!C
  pkg: string; // '4W  RTO'!D
  mismatch?: string; // registration and printed RTO location disagree
}

/** Grid keys to try for a registration mark or RTO code: Delhi-style DL3C first, then XX99. */
export function rtoKeys(raw: string): string[] {
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const m = s.match(/^([A-Z]{2})(\d{1,2})/);
  if (!m) return [];
  return [...(/^[A-Z]{2}\d[A-Z]/.test(s) ? [s.slice(0, 4)] : []), m[1] + m[2].padStart(2, '0')];
}

/** The '4W  RTO' row for the vehicle, or a stopping TP component. */
function lookupRto(ctx: Ctx, facts: PolicyFacts): RtoHit | RateComponent {
  const user = facts.rtoCode.status === 'user' && facts.rtoCode.value ? facts.rtoCode : null;
  const src = user ?? (facts.registrationNumber.value ? facts.registrationNumber : facts.rtoCode);
  const srcLabel = src === facts.registrationNumber ? 'Registration number' : 'RTO code';
  if (!src.value) {
    const reason = 'The registration number / RTO code is missing, and the Go Digit rate depends on the RTO cluster.';
    ask(ctx, 'registrationNumber', 'What is the vehicle registration number (for example UP78FZ1372)?');
    step(ctx, 'RTO code', reason, 'stop');
    return component('ambiguous', { appliesTo: TP_BASE, reason });
  }
  doubt(ctx, srcLabel, src);
  const keys = rtoKeys(src.value);
  const code = keys.find((k) => grid.rto[k]);
  if (!code) {
    const reason = `RTO ${keys.at(-1) ?? src.value} (from ${srcLabel.toLowerCase()} ${src.value}) is not in the Go Digit 4W RTO map.`;
    const c = [cite(RTO, 'B3:B1724', null, 'All 1722 RTO codes of the 4W map; no match')];
    step(ctx, 'RTO code', reason, 'stop', c);
    return unsupported(TP_BASE, reason, c);
  }
  const [row, tp, pkg] = grid.rto[code];
  step(ctx, 'RTO code', `${srcLabel} ${src.value} -> ${code}, found at '4W  RTO'!B${row}.`, 'ok', [cite(RTO, `B${row}`, code, 'RTO code')]);
  const mismatch = user ? null : crossCheck(ctx, facts, code);
  return { code, row, tp, pkg, ...(mismatch ? { mismatch } : {}) };
}

/** A rate reached through a disputed RTO stays a candidate until the user confirms the RTO. */
function disputed(hit: RtoHit, c: RateComponent): RateComponent {
  if (!hit.mismatch) return c;
  const candidates = c.applicability === 'applicable' && c.ratePercent !== null
    ? [{ ratePercent: c.ratePercent, assumption: `RTO ${hit.code} from the registration number is right`, citations: c.citations }]
    : (c.candidates ?? []);
  return ambiguousComponent(c.appliesTo, `${hit.mismatch} ${c.reason}`, candidates, c.premiumBase);
}

/** Printed RTO location vs the registration-derived code ('CV RTO Mapping' holds city/state). Returns a disagreement. */
function crossCheck(ctx: Ctx, facts: PolicyFacts, code: string): string | null {
  const cv = grid.cvRto[code];
  const loc = facts.rtoLocation.value;
  const cites = cv ? [cite(CV, `A${cv[0]}:C${cv[0]}`, `${code} | ${cv[1]} | ${cv[2]}`, 'RTO code, state and city in the CV RTO map')] : [];
  if (!loc) {
    step(ctx, 'Location cross-check', 'No RTO location was read from the policy; the registration-derived code is used unchecked.', 'warn', cites);
    return null;
  }
  // CV map states read like "DELHI - IN NCR"; fall back to the registration prefix when unknown.
  const codeState = stateFromCode((cv && stateCodeFromName(cv[1].replace(/\s*-.*$/, ''))) || code.slice(0, 2));
  const printed = facts.state.status === 'derived' || !facts.state.value ? null : stateFromCode(stateCodeFromName(facts.state.value) ?? '');
  if (printed && codeState && printed !== codeState) {
    const reason = `The registration points to RTO ${code} in ${codeState}, but the policy prints RTO location "${loc}" (${printed}).`;
    ask(ctx, 'rtoCode', `Which RTO is the vehicle registered at? The registration number gives ${code} (${codeState}); the schedule prints "${loc}".`, [
      { value: code, label: `${code} (from the registration number)` },
    ]);
    step(ctx, 'Location cross-check', `${reason} The lookup continues with ${code}, but the result stays ambiguous until the RTO is confirmed.`, 'warn', cites);
    ctx.doubts.push('The registration number and the printed RTO location disagree');
    return reason;
  }
  const cityOk = !!cv && squash(loc).includes(squash(cv[2]));
  const state = printed ? 'is in the same state' : 'names no state that could be compared';
  const detail = cv
    ? `'CV RTO Mapping' row ${cv[0]}: ${code} = ${cv[2]}, ${cv[1]}. The printed RTO location "${loc}" ${cityOk ? 'agrees' : `${state}, but not the same city (not decisive)`}.`
    : `${code} is not in 'CV RTO Mapping'; the printed RTO location "${loc}" ${state}.`;
  step(ctx, 'Location cross-check', detail, cityOk ? 'ok' : 'warn', cites);
  return null;
}

// ---------- 4W SATP ----------

interface Value<T> {
  v: T;
  label: string;
}

interface Axis<T> {
  fact: FactKey;
  known: boolean;
  values: Value<T>[];
}

interface Scenario {
  fuel: Value<GridFuel>;
  cc: Value<number>;
  age: Value<number>;
}

type Outcome =
  | { kind: 'rate'; rows: SatpRow[]; beaten: SatpRow[]; rule?: NoteRule } // rule = an unnamed-RTO decline note
  | { kind: 'declined'; rule: NoteRule; rows: SatpRow[] }
  | { kind: 'no_row' }
  | { kind: 'multi'; rows: SatpRow[] };

const AXIS_LABEL: Partial<Record<FactKey, string>> = { fuel: 'fuel', cngLpgKit: 'CNG/LPG kit', cc: 'cubic capacity', vehicleAgeYears: 'vehicle age' };
const CC_POINTS: Value<number>[] = [
  { v: 1000, label: 'up to 1000 cc' },
  { v: 1200, label: '1001-1500 cc' },
  { v: 2000, label: 'above 1500 cc' },
];
const AGE_POINTS: Value<number>[] = [
  { v: 5, label: 'under 10 years old' },
  { v: 12, label: '10 or more years old' },
];

function fuelAxis(facts: PolicyFacts): Axis<GridFuel> | RateComponent {
  const fuel = facts.fuel.value;
  const kit = facts.cngLpgKit.value;
  if (fuel === 'electric' || fuel === 'hybrid') {
    return unsupported(TP_BASE, `'4W SATP' has no ${fuel} segment (column C has only Petrol, Diesel and CNG bands).`, [cite(SATP, 'C3:C328', null, 'Segment column')]);
  }
  if (fuel === 'cng' || fuel === 'lpg') return { fact: 'fuel', known: true, values: [{ v: 'CNG', label: fuel === 'lpg' ? 'LPG, rated on the CNG rows' : 'CNG' }] };
  if (fuel === 'petrol' || fuel === 'diesel') {
    const base: GridFuel = fuel === 'petrol' ? 'Petrol' : 'Diesel';
    const withKit: Value<GridFuel> = { v: 'CNG', label: `${base} with a CNG/LPG kit (CNG rows)` };
    if (kit === true) return { fact: 'cngLpgKit', known: true, values: [withKit] };
    if (kit === false) return { fact: 'cngLpgKit', known: true, values: [{ v: base, label: `${base}, no CNG/LPG kit` }] };
    return { fact: 'cngLpgKit', known: false, values: [{ v: base, label: `${base}, no CNG/LPG kit` }, withKit] };
  }
  return { fact: 'fuel', known: false, values: (['Petrol', 'Diesel', 'CNG'] as const).map((v) => ({ v, label: v })) };
}

function numberAxis(fact: FactKey, f: Fact<number>, unit: string, points: Value<number>[]): Axis<number> {
  if (f.value !== null) return { fact, known: true, values: [{ v: f.value, label: `${f.value} ${unit}` }] };
  if (f.candidates?.length) return { fact, known: false, values: f.candidates.map((v) => ({ v, label: `${v} ${unit}` })) };
  return { fact, known: false, values: points };
}

const inRange = (x: number, min: number, max: number | null) => x >= min && (max === null || x <= max);
const ageBand = (age: number): AgeBand => (age < 10 ? '<10' : '>10');
const width = (r: SatpRow) => (r.ccMax ?? 100000) - r.ccMin;

/** Rows for one scenario: narrowest cc band first, then a specific age band over All (spec 3.5). */
function select(rows: SatpRow[], clusterKey: string, s: Scenario): Outcome {
  const band = ageBand(s.age.v);
  const rule = grid.notes.find((n) => n.clusters.includes(clusterKey) && (!n.fuel || n.fuel === s.fuel.v)
    && inRange(s.cc.v, n.ccMin, n.ccMax) && (!n.age || n.age === band));
  const hits = rows.filter((r) => r.fuel === s.fuel.v && inRange(s.cc.v, r.ccMin, r.ccMax) && (r.age === 'All' || r.age === band));
  const narrow = hits.filter((r) => width(r) === Math.min(...hits.map(width)));
  const best = narrow.some((r) => r.age !== 'All') ? narrow.filter((r) => r.age !== 'All') : narrow;
  if (rule?.effect === 'declined') return { kind: 'declined', rule, rows: best };
  if (!best.length) return { kind: 'no_row' };
  if (new Set(best.map((r) => r.pct)).size > 1) return { kind: 'multi', rows: best };
  return { kind: 'rate', rows: best, beaten: hits.filter((r) => !best.includes(r)), ...(rule ? { rule } : {}) };
}

function outcomeKey(o: Outcome): string {
  if (o.kind === 'rate') return `${o.rule ? 'some' : 'rate'}:${o.rows[0].pct}`;
  if (o.kind === 'declined') return `declined:${o.rule.cell}`;
  if (o.kind === 'multi') return `multi:${o.rows.map((r) => r.row).join()}`;
  return 'no_row';
}

const rowCites = (r: SatpRow, label: string): Citation[] => [
  cite(SATP, `B${r.row}`, r.cluster, 'Cluster label'),
  cite(SATP, `C${r.row}`, r.segment, 'Segment (fuel and cc band)'),
  cite(SATP, `D${r.row}`, r.age, 'Age band'),
  cite(SATP, `E${r.row}`, r.raw, label),
];
const rowText = (r: SatpRow) => `E${r.row} (${r.cluster.trim()} | ${r.segment} | ${r.age}) = ${pct(r.pct)}`;
const noteCite = (n: NoteRule) => cite(SATP, n.cell, n.text, 'Column-F note (applies to its cluster)');

function satp(ctx: Ctx, facts: PolicyFacts): RateResult {
  const header = grid.satp.header.join(' | ');
  const headerCite = cite(SATP, 'B2:F2', header, 'Sheet header: no OD column; E = Max CD2 (TP rate)');
  step(ctx, 'Sheet', "Liability-only (SATP) private car -> '4W SATP'. 'TW 1+1 & SATP' is a two-wheeler sheet and is not used.", 'ok', [headerCite]);
  const od = notApplicable(OD_BASE, "Stand-alone TP policy: there is no own-damage premium, and '4W SATP' has no OD column.", [headerCite]);
  const tp = satpTp(ctx, facts);
  premiumStep(ctx, facts, tp);
  step(ctx, 'OD', od.reason, 'ok', od.citations);
  return finish(ctx, od, tp);
}

function premiumStep(ctx: Ctx, facts: PolicyFacts, tp: RateComponent): void {
  if (tp.applicability !== 'applicable' && tp.applicability !== 'ambiguous') return;
  const { netTp, netPremium } = facts.premium;
  step(ctx, 'Premium base (open question)',
    `The grid does not say which premium the TP rate applies to: basic TP (${rupees(netTp.value)}) or the net liability premium (${rupees(netPremium.value)}, which adds lines such as LL to paid driver). `
    + `Following the spec, the rate is applied to basic TP, excluding GST${tp.expectedBrokerage !== null ? ` -> ${rupees(tp.expectedBrokerage)}` : ''}. This does not change the rate.`, 'warn');
}

function satpTp(ctx: Ctx, facts: PolicyFacts): RateComponent {
  const hit = lookupRto(ctx, facts);
  return 'code' in hit ? disputed(hit, satpRate(ctx, facts, hit)) : hit;
}

function satpRate(ctx: Ctx, facts: PolicyFacts, hit: RtoHit): RateComponent {
  const clusterKey = hit.tp.trim().toUpperCase();
  const rtoCites = [cite(RTO, `B${hit.row}`, hit.code, 'RTO code'), cite(RTO, `C${hit.row}`, hit.tp, '4WTP cluster (header C2 = 4WTP)')];
  step(ctx, 'Cluster', `'4W  RTO'!C${hit.row} (4WTP) = ${hit.tp}.`, 'ok', rtoCites);
  if (clusterKey === 'ALL_INDIA_DECLINE') {
    const reason = `DECLINED: RTO ${hit.code} maps to cluster All_India_Decline, whose '4W SATP' rows B3:E8 are all 0.`;
    const c = [...rtoCites, cite(SATP, 'B3:E8', 0, 'All_India_Decline rows: every Max CD2 is 0')];
    step(ctx, 'Decline', reason, 'stop', c);
    return unsupported(TP_BASE, reason, c);
  }
  const cluster = grid.satp.clusters[clusterKey];
  const rows = cluster.rows.map((r) => ROWS.get(r) as SatpRow);
  const span = `B${cluster.rows[0]}:B${cluster.rows.at(-1)}`;
  step(ctx, 'Cluster rows', `${hit.tp} -> '4W SATP' label(s) ${cluster.labels.map((l) => `"${l}"`).join(', ')}: rows ${cluster.rows.join(', ')}.`, 'ok',
    [cite(SATP, span, cluster.labels.join(' / '), `Rows of the cluster: ${cluster.rows.join(', ')}`)]);

  const fuel = fuelAxis(facts);
  if (!('values' in fuel)) {
    step(ctx, 'Segment', fuel.reason, 'stop', fuel.citations);
    return fuel;
  }
  doubt(ctx, 'Fuel', facts.fuel);
  if (fuel.fact === 'cngLpgKit' && fuel.known) doubt(ctx, facts.cngLpgKit.value ? 'CNG/LPG kit' : 'No CNG/LPG kit', facts.cngLpgKit);
  doubt(ctx, 'Cubic capacity', facts.cc);
  const axes = { fuel, cc: numberAxis('cc', facts.cc, 'cc', CC_POINTS), age: numberAxis('vehicleAgeYears', facts.vehicleAgeYears, 'years', AGE_POINTS) };
  const scenarios: Scenario[] = [];
  for (const f of fuel.values) for (const c of axes.cc.values) for (const a of axes.age.values) scenarios.push({ fuel: f, cc: c, age: a });
  const outcomes = scenarios.map((s) => ({ s, o: select(rows, clusterKey, s) }));
  const keys = new Set(outcomes.map(({ o }) => outcomeKey(o)));
  const context = { ctx, facts, hit, rtoCites, axes };
  if (keys.size === 1) return single(context, outcomes[0].s, outcomes[0].o, outcomes.length);
  return several(context, outcomes);
}

interface SatpContext {
  ctx: Ctx;
  facts: PolicyFacts;
  hit: RtoHit;
  rtoCites: Citation[];
  axes: { fuel: Axis<GridFuel>; cc: Axis<number>; age: Axis<number> };
}

/** Every combination of the unknown facts gives the same outcome. */
function single(sc: SatpContext, s: Scenario, o: Outcome, combos: number): RateComponent {
  const { ctx, facts, hit, rtoCites, axes } = sc;
  const unknown = Object.values(axes).filter((a) => !a.known);
  if (combos > 1) {
    step(ctx, 'Unknown facts', `Not known exactly: ${unknown.map((a) => AXIS_LABEL[a.fact]).join(', ')}. All ${combos} possible combinations give the same result, so they do not change the answer.`, 'ok');
  }
  const segment = `${s.fuel.label}${axes.cc.known ? `, ${s.cc.label}` : ''}`;
  if (o.kind === 'declined') {
    const reason = `DECLINED: '4W SATP'!${o.rule.cell} "${o.rule.text}" covers ${hit.tp} ${segment}${axes.age.known ? `, ${s.age.label}` : ''}.`;
    const c = [...rtoCites, noteCite(o.rule), ...o.rows.flatMap((r) => rowCites(r, `Row value ${pct(r.pct)}, overridden by the note`))];
    step(ctx, 'Notes and declines', reason, 'stop', c);
    return unsupported(TP_BASE, reason, c);
  }
  if (o.kind === 'no_row') {
    const reason = `No '4W SATP' row for cluster ${hit.tp} with ${segment}: the grid does not cover this segment.`;
    step(ctx, 'Segment', reason, 'stop', rtoCites);
    return unsupported(TP_BASE, reason, rtoCites);
  }
  if (o.kind === 'multi') {
    const reason = `Several equally specific rows match with different rates: ${o.rows.map(rowText).join('; ')}.`;
    step(ctx, 'Segment', reason, 'stop');
    ctx.doubts.push('Overlapping grid rows');
    return ambiguousComponent(TP_BASE, reason, o.rows.map((r) => ({ ratePercent: r.pct, assumption: `Row ${r.row}`, citations: [...rtoCites, ...rowCites(r, 'Max CD2')] })), facts.premium.netTp.value);
  }
  const r = o.rows[0];
  const beaten = o.beaten.length ? ` It is more specific than ${o.beaten.map(rowText).join('; ')}, which also match (narrowest cc band first, then a specific age band over All).` : '';
  step(ctx, 'Segment', `${segment} -> '${r.segment}' (row ${r.row}${o.rows.length > 1 ? `; duplicate rows ${o.rows.map((x) => x.row).join(', ')} carry the same value` : ''}).${beaten}`, 'ok',
    [cite(SATP, `C${r.row}`, r.segment, 'Segment (fuel and cc band)')]);
  if (r.age !== 'All') doubt(ctx, 'Vehicle age', facts.vehicleAgeYears);
  const ageText = facts.vehicleAgeYears.value ?? facts.vehicleAgeYears.candidates?.join(' or ') ?? 'unknown';
  step(ctx, 'Age', r.age === 'All'
    ? `D${r.row} = All, so the vehicle age (${ageText} years) is not needed.`
    : `Vehicle age ${ageText} years -> band ${r.age}, matching D${r.row}.`, 'ok', [cite(SATP, `D${r.row}`, r.age, 'Age band')]);
  const lpg = facts.fuel.value === 'lpg';
  const c = [...rtoCites, ...o.rows.flatMap((x) => rowCites(x, `Max CD2 (TP rate) ${pct(x.pct)}`))];
  if (o.rule) {
    const reason = `'4W SATP'!${o.rule.cell} says "${o.rule.text}" without naming the RTOs: ${rowText(r)}, or declined if RTO ${hit.code} is one of them.`;
    step(ctx, 'Notes and declines', reason, 'stop', [noteCite(o.rule)]);
    ctx.doubts.push(`Note ${o.rule.cell} declines unnamed RTOs`);
    return ambiguousComponent(TP_BASE, reason, [{ ratePercent: r.pct, assumption: `RTO ${hit.code} is not among the RTOs note ${o.rule.cell} declines`, citations: [...c, noteCite(o.rule)] }], facts.premium.netTp.value);
  }
  const own = r.note ? `F${r.row} ("${r.note}") does not cover this case` : `F${r.row} is empty`;
  step(ctx, 'Notes and declines', `Cluster ${hit.tp} is not All_India_Decline, ${own}, and no other column-F note covers this cluster and segment.`, 'ok',
    [cite(SATP, `F${r.row}`, r.note ?? null, 'Note column')]);
  const zero = r.pct === 0;
  step(ctx, 'Rate', `'4W SATP'!E${r.row} (Max CD2) = ${r.raw} -> TP ${pct(r.pct)}.${zero ? ` ${ZERO_WARNING}` : ''}`, zero ? 'warn' : 'ok',
    [cite(SATP, `E${r.row}`, r.raw, `Max CD2 (TP rate) ${pct(r.pct)}`)]);
  if (lpg) {
    const reason = `'4W SATP' has no LPG segment; on the CNG rows the rate would be ${rowText(r)}.`;
    ask(ctx, 'fuel', "The grid has no LPG segment. Should the vehicle be rated on the CNG rows?", [{ value: 'cng', label: 'Yes, rate it as CNG' }]);
    step(ctx, 'Fuel', reason, 'stop');
    return ambiguousComponent(TP_BASE, reason, [{ ratePercent: r.pct, assumption: 'LPG rated as CNG', citations: c }], facts.premium.netTp.value);
  }
  return component('applicable', {
    ratePercent: r.pct,
    appliesTo: TP_BASE,
    premiumBase: facts.premium.netTp.value,
    reason: `'4W SATP'!${rowText(r)} (Max CD2, cluster ${hit.tp} for RTO ${hit.code}).${zero ? ` ${ZERO_WARNING}` : ''}`,
    citations: c,
  });
}

/** The unknown facts change the outcome: ambiguous, with candidates and a question per fact that matters. */
function several(sc: SatpContext, outcomes: { s: Scenario; o: Outcome }[]): RateComponent {
  const { ctx, facts, hit, rtoCites, axes } = sc;
  const names = ['fuel', 'cc', 'age'] as const;
  // A fact matters when changing only that fact changes the outcome.
  const matters = names.filter((n) => {
    const byRest = new Map<string, Set<string>>();
    for (const { s, o } of outcomes) {
      const rest = names.filter((m) => m !== n).map((m) => s[m].v).join('|');
      byRest.set(rest, (byRest.get(rest) ?? new Set<string>()).add(outcomeKey(o)));
    }
    return [...byRest.values()].some((set) => set.size > 1);
  });
  const describe = (s: Scenario) => matters.map((n) => s[n].label).join(', ');
  const groups = new Map<string, { o: Outcome; labels: string[] }>();
  for (const { s, o } of outcomes) {
    const g = groups.get(outcomeKey(o)) ?? { o, labels: [] };
    g.labels.push(describe(s));
    groups.set(outcomeKey(o), g);
  }
  const candidates: RateCandidate[] = [];
  const parts: string[] = [];
  for (const { o, labels } of groups.values()) {
    const when = [...new Set(labels)].join(' or ');
    if (o.kind === 'declined') parts.push(`${when}: declined by note ${o.rule.cell}`);
    else if (o.kind === 'no_row') parts.push(`${when}: no grid row`);
    else {
      for (const r of o.kind === 'multi' ? o.rows : o.rows.slice(0, 1)) {
        const unless = o.kind === 'rate' && o.rule ? `, unless note ${o.rule.cell} declines RTO ${hit.code}` : '';
        parts.push(`${when}: ${rowText(r)}${unless}`);
        candidates.push({ ratePercent: r.pct, assumption: `${when}${unless}`, citations: [...rtoCites, ...rowCites(r, `Max CD2 (TP rate) ${pct(r.pct)}`)] });
      }
    }
  }
  for (const n of matters) {
    const a = axes[n];
    ctx.doubts.push(`The ${AXIS_LABEL[a.fact]} is not known`);
    if (a.fact === 'fuel') ask(ctx, 'fuel', 'What fuel does the vehicle use?', ['petrol', 'diesel', 'cng', 'lpg', 'electric'].map((v) => ({ value: v, label: v })));
    if (a.fact === 'cngLpgKit') ask(ctx, 'cngLpgKit', 'Is a CNG/LPG kit fitted (bi-fuel kit TP charged)?', [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]);
    if (a.fact === 'cc') ask(ctx, 'cc', 'What is the engine cubic capacity (cc)?');
    if (a.fact === 'vehicleAgeYears') {
      const opts = facts.vehicleAgeYears.candidates?.map((v) => ({ value: String(v), label: `${v} years` }));
      ask(ctx, 'vehicleAgeYears', 'How old is the vehicle at the policy start, in whole years (from the registration date)?', opts);
    }
  }
  const reason = `The rate depends on the ${matters.map((n) => AXIS_LABEL[axes[n].fact]).join(' and ')}, which the policy does not settle: ${parts.join('; ')}.`;
  step(ctx, 'Segment', reason, 'stop', candidates.flatMap((x) => x.citations.slice(-1)));
  return ambiguousComponent(TP_BASE, reason, candidates, facts.premium.netTp.value);
}

// ---------- 4W New Business 1+3 ----------

function makeColumns(make: string): string[] {
  const m = squash(make);
  const cols = Object.entries(grid.newBusiness.makes)
    .filter(([, names]) => names.some((n) => n !== 'Others' && (m.startsWith(squash(n)) || (m.length >= 4 && squash(n).startsWith(m)))))
    .map(([c]) => c);
  return cols.length ? cols : ['H']; // H3 ends with "Others"
}

function newBusiness(ctx: Ctx, facts: PolicyFacts): RateResult {
  const [h13, h33] = grid.newBusiness.header;
  step(ctx, 'Sheet', `New-business package -> '${NB}': ${h13.cell} "${h13.value}" (columns ${h13.columns}), ${h33.cell} "${h33.value}" (column ${h33.columns}).`, 'ok',
    grid.newBusiness.header.map((h) => cite(NB, h.cell, h.value, `Merged header over columns ${h.columns}`)));
  const hit = lookupRto(ctx, facts);
  if (!('code' in hit)) return finish(ctx, { ...hit, appliesTo: OD_BASE }, hit);
  const row = grid.newBusiness.rows[hit.pkg.trim().toUpperCase()];
  const rtoCites = [cite(RTO, `B${hit.row}`, hit.code, 'RTO code'), cite(RTO, `D${hit.row}`, hit.pkg, '4W Package cluster (header D2)'), cite(NB, `A${row.row}`, row.label, 'Cluster row')];
  step(ctx, 'Cluster', `'4W  RTO'!D${hit.row} (4W Package) = ${hit.pkg} -> '${NB}'!A${row.row} "${row.label}".`, 'ok', rtoCites);
  const make = facts.make.value;
  const cols = make ? makeColumns(make) : [...'BCDEFGH'];
  if (!make) ask(ctx, 'make', 'What is the vehicle make (manufacturer)?');
  else doubt(ctx, 'Make', facts.make);
  step(ctx, 'Make column', make
    ? `Make ${make} -> column(s) ${cols.map((c) => `${c}3 "${grid.newBusiness.makes[c].join(', ')}"`).join(' and ')}.`
    : 'Make unknown: every make column is a candidate.', cols.length === 1 ? 'ok' : 'warn', cols.map((c) => cite(NB, `${c}3`, grid.newBusiness.makes[c].join(', '), 'Make column header')));
  const cand = (c: string, term: string): RateCandidate => ({
    ratePercent: Number((row.rates[c] * 100).toFixed(4)),
    assumption: `${term} term, ${c === 'I' ? 'any make' : `make column ${c}`}; one combined CD2 applied to the OD and the TP premium alike`,
    citations: [...rtoCites, cite(NB, `${c}${row.row}`, row.rates[c], `Combined CD2, ${term}`)],
  });
  const candidates = [...cols.map((c) => cand(c, '1+3')), cand('I', '3+3')];
  const reason = `'${NB}' publishes one combined CD2 per cluster and make, not split into OD and TP, and the 1+3 / 3+3 term is not read from the policy: ${candidates.map((x) => `${pct(x.ratePercent)} (${x.assumption.split(';')[0]})`).join('; ')}.`;
  ctx.doubts.push('The new-business sheet does not split OD and TP');
  step(ctx, 'Rate', reason, 'stop', candidates.map((x) => x.citations.at(-1) as Citation));
  return finish(ctx, disputed(hit, ambiguousComponent(OD_BASE, reason, candidates, facts.premium.netOd.value)),
    disputed(hit, ambiguousComponent(TP_BASE, reason, candidates, facts.premium.netTp.value)));
}
