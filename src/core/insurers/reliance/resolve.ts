// Deterministic Reliance General private-car lookup (spec: specs/reliance.md, section 3).
// Each decision dimension (business type, policy type, geography, fuel, cc) becomes a list of
// choices: one when the fact is known, several when it is missing or the grid is open. Every
// combination is rated from the grid; a component resolves only when all combinations agree,
// otherwise it is ambiguous with candidates and a question for each fact that changes the rate.
import type {
  Citation,
  ClarifyingQuestion,
  Fact,
  FactKey,
  PolicyFacts,
  PolicyType,
  RateCandidate,
  RateComponent,
  RateResult,
  TraceStep,
} from '../../types';
import { ambiguousComponent, buildResult, component, notApplicable, pct, toPercent, unsupported } from '../module';
import { grid, type PcRow } from './grid';

const FILE = grid.source.file;
const PC = grid.pc.sheet;
const MAIN = grid.main.sheet;
const RTO = grid.rto.sheet;
const OD_BASE = 'net OD premium (after NCB, incl. add-ons)';
const TP_BASE = 'basic TP premium';

type Band = 'AR' | 'AS' | 'AT';
const BAND_LABEL: Record<Band, string> = { AR: 'cc below 1000', AS: 'cc 1000-1500', AT: 'cc above 1500' };

interface Choice<T> {
  value: T;
  assumption: string;
  citations: Citation[];
}

interface Dim<T> {
  fact: FactKey | null; // the fact a user answer would settle; null when the grid itself is open
  choices: Choice<T>[];
}

interface Geo {
  row: PcRow;
  mainRow: number;
}

interface FuelChoice {
  col: 'C' | 'D';
  nonDiesel: boolean;
}

type Outcome =
  | { kind: 'rate'; rate: number; reason: string; citations: Citation[] }
  | { kind: 'na'; reason: string }
  | { kind: 'unsupported'; reason: string; citations: Citation[] };

interface Addons {
  known: boolean;
  zeroDep: boolean;
  tyreOrRti: boolean;
  cpa: boolean;
}

const cite = (sheet: string, cell: string, value: string | number | null, label: string): Citation => ({ file: FILE, sheet, cell, value, label });
const pcNote = (cell: string, label: string) => cite(PC, cell, grid.pc.text[cell], label);
const pcRow = (n: number) => grid.pc.rows.find((r) => r.row === n)!;
const one = <T>(value: T): Dim<T> => ({ fact: null, choices: [{ value, assumption: '', citations: [] }] });

const QUESTIONS: Partial<Record<FactKey, ClarifyingQuestion>> = {
  businessType: {
    fact: 'businessType',
    question: 'Is this a new car policy, a renewal with Reliance General, or a rollover from another insurer? The private-car grid covers renewals and rollovers only.',
    options: [
      { value: 'renewal', label: 'Renewal (previous policy with Reliance General)' },
      { value: 'rollover', label: 'Rollover (previous policy with another insurer)' },
      { value: 'new', label: 'New car / fresh policy' },
    ],
  },
  policyType: {
    fact: 'policyType',
    question: 'Which cover does the policy give?',
    options: [
      { value: 'package', label: 'Package / comprehensive (OD + TP)' },
      { value: 'saod', label: 'Stand-alone own damage' },
      { value: 'satp', label: 'Third party only' },
    ],
  },
  rtoCode: { fact: 'rtoCode', question: 'Which RTO is the car registered at (for example UP-16)? The grid region comes from the RTO code.' },
  fuel: {
    fact: 'fuel',
    question: 'What fuel does the car run on? The grid pays petrol / bi-fuel (column C) and diesel / EV (column D) differently.',
    options: [
      { value: 'petrol', label: 'Petrol' },
      { value: 'cng', label: 'CNG (factory or kit)' },
      { value: 'lpg', label: 'LPG' },
      { value: 'diesel', label: 'Diesel' },
      { value: 'electric', label: 'Electric' },
    ],
  },
  cc: { fact: 'cc', question: 'What is the engine cubic capacity (cc)? Cars below 1000 cc get a lower rate (PC!H3).' },
};

// ---------- dimensions ----------

function businessDim(f: Fact<string>): Dim<'old' | 'new'> {
  const known = f.value ?? (f.candidates?.length && !f.candidates.includes('new') ? 'renewal' : null);
  if (known) return one(known === 'new' ? 'new' : 'old');
  return {
    fact: 'businessType',
    choices: [
      { value: 'old', assumption: 'renewal or rollover (Old Business)', citations: [] },
      { value: 'new', assumption: 'new business', citations: [] },
    ],
  };
}

function policyDim(f: Fact<PolicyType>): Dim<PolicyType> {
  if (f.value) return one(f.value);
  const types: PolicyType[] = f.candidates?.length ? f.candidates : ['package', 'saod', 'satp'];
  return { fact: 'policyType', choices: types.map((t) => ({ value: t, assumption: `policy type ${t}`, citations: [] })) };
}

/** Registration mark or RTO code -> RTO List keys, longest first ("DL3CAB1234" -> DL03CA, DL3CA, DL03C, DL3C, DL03, DL3). */
function rtoKeys(code: string): { state: string; keys: string[] } | null {
  const m = code.toUpperCase().replace(/^[^A-Z]+/, '').match(/^([A-Z]{2})[\s-]*0*(\d{1,3})[\s-]*([A-Z]{0,3})/);
  if (!m) return null;
  const [, state, district, series] = m;
  const digits = [district.padStart(2, '0'), district];
  const keys = [series.slice(0, 2), series.slice(0, 1), ''].flatMap((s) => digits.map((d) => state + d + s));
  return { state, keys: [...new Set(keys)].sort((a, b) => b.length - a.length) };
}

function regionChoices(cities: string[], assumption: (city: string, row: PcRow) => string): Choice<Geo>[] {
  const seen = new Set<string>();
  const out: Choice<Geo>[] = [];
  for (const city of cities) {
    const region = grid.regions[city];
    for (const n of region.pcRows) {
      const key = `${n}/${region.mainRow}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const row = pcRow(n);
      out.push({ value: { row, mainRow: region.mainRow }, assumption: assumption(city, row), citations: [cite(PC, `B${n}`, row.label, `Grid region row ${n}`)] });
    }
  }
  return out;
}

function geoDim(facts: PolicyFacts, trace: TraceStep[]): Dim<Geo> | string {
  const source = facts.rtoCode.status !== 'user' && facts.registrationNumber.value ? facts.registrationNumber : facts.rtoCode;
  const parsed = source.value ? rtoKeys(source.value) : null;
  const allCities = Object.keys(grid.regions);
  if (!parsed) {
    trace.push({ title: 'Geography', detail: 'No registration number or RTO code: every grid region is a candidate.', outcome: 'warn' });
    return { fact: 'rtoCode', choices: regionChoices(allCities, (c, r) => `RTO in ${c} (row ${r.row} ${r.label})`) };
  }
  const key = parsed.keys.find((k) => grid.rto.codes[k]);
  if (key) {
    const [row, code, city] = grid.rto.codes[key];
    const region = grid.regions[city];
    const rtoCites = [
      cite(RTO, `A${row}`, code, `RTO code ${code} (matched from ${source.value})`),
      cite(RTO, `C${row}`, city, `Region_City of ${code}`),
    ];
    const rows = region.pcRows.map((n) => `row ${n} "${pcRow(n).label}"`).join(' or ');
    trace.push({
      title: 'Geography',
      detail: `${source.value} -> key ${key} -> ${RTO}!A${row} ${code}, Region_City ${city} -> PC ${rows}. The RTO List city overrides the registration state.${region.note ? ` ${region.note}.` : ''}`,
      citations: rtoCites,
      outcome: region.note ? 'warn' : 'ok',
    });
    const choices = regionChoices([city], (c, r) => `${c} read as row ${r.row} "${r.label}"`);
    for (const c of choices) c.citations.unshift(...rtoCites);
    return { fact: null, choices };
  }
  const cities = [...new Set(Object.entries(grid.rto.codes).filter(([k]) => k.startsWith(parsed.state)).map(([, v]) => v[2]))];
  if (!cities.length) {
    const reason = `RTO code ${source.value} is not in ${RTO} and no RTO there starts with ${parsed.state}.`;
    trace.push({ title: 'Geography', detail: reason, outcome: 'stop' });
    return reason;
  }
  const choices = regionChoices(cities, (c, r) => `RTO in ${c} (row ${r.row} "${r.label}")`);
  const rows = [...new Set(choices.map((c) => c.value.row.row))];
  trace.push({
    title: 'Geography',
    detail: `${source.value} is not in ${RTO}. Every ${parsed.state} RTO there maps to ${rows.length === 1 ? `the same row ${rows[0]} "${pcRow(rows[0]).label}"` : `rows ${rows.join(', ')}`}, so the state prefix ${rows.length === 1 ? 'decides the row' : 'does not decide the row'}.`,
    outcome: 'warn',
  });
  return { fact: 'rtoCode', choices };
}

function fuelChoice(fuel: string): Choice<FuelChoice>[] {
  const c = (col: 'C' | 'D', nonDiesel: boolean, assumption: string): Choice<FuelChoice> => ({
    value: { col, nonDiesel },
    assumption,
    citations: [pcNote(`${col}2`, `Column header: ${grid.pc.text[`${col}2`]}`)],
  });
  if (fuel === 'diesel') return [c('D', false, 'fuel diesel (column D)')];
  if (fuel === 'electric') return [c('D', true, 'fuel electric (column D)')];
  if (fuel === 'hybrid') return [c('C', true, 'hybrid read as petrol (column C)'), c('D', true, 'hybrid read with diesel/EV (column D)')];
  return [c('C', true, `fuel ${fuel} (column C)`)];
}

function fuelDim(f: Fact<string>): Dim<FuelChoice> {
  const fuels = f.value ? [f.value] : f.candidates?.length ? f.candidates : ['petrol', 'diesel'];
  const choices = fuels.flatMap(fuelChoice).filter((c, i, all) => all.findIndex((o) => o.value.col === c.value.col && o.value.nonDiesel === c.value.nonDiesel) === i);
  return { fact: choices.length > 1 ? 'fuel' : null, choices };
}

function ccDim(f: Fact<number>): Dim<Band> {
  if (f.value !== null) return one(f.value < 1000 ? 'AR' : f.value <= 1500 ? 'AS' : 'AT');
  return { fact: 'cc', choices: (['AR', 'AS', 'AT'] as Band[]).map((b) => ({ value: b, assumption: BAND_LABEL[b], citations: [] })) };
}

function addonsOf(facts: PolicyFacts): Addons {
  const covers = facts.covers.value;
  const has = (re: RegExp) => !!covers?.some((c) => re.test(c));
  return {
    known: !!covers,
    zeroDep: has(/nil dep|zero dep/i),
    tyreOrRti: has(/tyre protect|return to invoice|\bRTI\b/i),
    cpa: has(/compulsory PA|owner driver/i),
  };
}

// ---------- rating one combination ----------

interface Scenario {
  business: 'old' | 'new';
  policy: PolicyType;
  geo: Geo;
  fuel: FuelChoice;
  band: Band;
}

const NEW_BUSINESS = `New business: PC!A1 is the "Old Business" grid and the workbook has no private-car new-business grid.`;

function rateOd(s: Scenario, addons: Addons): Outcome {
  if (s.business === 'new') return { kind: 'unsupported', reason: NEW_BUSINESS, citations: [pcNote('A1', 'Grid title: Old Business only')] };
  if (s.policy === 'satp') return { kind: 'na', reason: 'Third-party-only policy: there is no OD premium.' };
  const { row } = s.geo;
  const col = s.policy === 'saod' ? 'E' : s.fuel.col;
  const header = grid.pc.text[`${col}2`];
  let rate = row[col];
  const steps = [`PC!${col}${row.row} = ${row[col]} (${row.label}, ${header})`];
  const citations = [cite(PC, `${col}${row.row}`, row[col], `Base OD rate: ${row.label}, ${header}`)];
  if (s.band === 'AR') {
    rate -= 5;
    steps.push('- 5 points for cc below 1000 (PC!H3, read as percentage points; 5% of the rate would give ' + pct(toPercent(row[col] * 0.95, false)) + ')');
    citations.push(pcNote('H3', 'cc below 1000: 5 points less'));
  }
  if (s.policy === 'saod' && addons.zeroDep) {
    rate -= 2.5;
    steps.push('- 2.5 points for a stand-alone OD policy with zero depreciation (PC!H4)');
    citations.push(pcNote('H4', 'Stand-alone OD with zero depreciation: 2.5 points less'));
  }
  if (addons.tyreOrRti) {
    rate += 2.5;
    steps.push('+ 2.5 points for a Tyre / RTI add-on (PC!H6)');
    citations.push(pcNote('H6', 'Tyre / RTI add-on: 2.5 points more'));
  }
  rate = Math.max(0, toPercent(rate, false));
  return { kind: 'rate', rate, reason: `${steps.join(' ')} = ${pct(rate)} of the ${OD_BASE}.`, citations };
}

function rateTp(s: Scenario): Outcome[] {
  if (s.business === 'new') return [{ kind: 'unsupported', reason: NEW_BUSINESS, citations: [pcNote('A1', 'Grid title: Old Business only')] }];
  if (s.policy === 'saod') return [{ kind: 'na', reason: 'Stand-alone OD policy: there is no TP premium.' }];
  const { row, mainRow } = s.geo;
  const stp = cite(PC, `F${row.row}`, row.F, `STP rate, ${row.label}`);
  const m = grid.main.rows[mainRow];
  const mainRate = toPercent(m[s.band], true);
  const mainCite = cite(MAIN, `${s.band}${mainRow}`, m[s.band], `${grid.main.text.AR2}, ${grid.main.text[`${s.band}3`]}, ${m.region}`);
  if (s.policy === 'package') {
    return [{
      kind: 'rate',
      rate: 0,
      reason: `PC!H2 "${grid.pc.text.H2}": a package policy earns its payout on the OD premium only, so TP is 0%. PC!F${row.row} (STP) = ${row.F}${s.fuel.nonDiesel ? ` and ${MAIN}!${s.band}${mainRow} (PC STP Non-Diesel) = ${m[s.band]} agree` : ' agrees'}.`,
      citations: [pcNote('H2', 'Payout on OD premium only: TP 0%'), stp, ...(s.fuel.nonDiesel ? [mainCite] : [])],
    }];
  }
  const viaPc: Outcome = { kind: 'rate', rate: row.F, reason: `PC!F${row.row} (STP, ${row.label}) = ${row.F}%.`, citations: [stp] };
  if (!s.fuel.nonDiesel) return [viaPc];
  if (mainRate === row.F) {
    return [{ ...viaPc, reason: `${viaPc.reason} Cross-check ${MAIN}!${s.band}${mainRow} (${m.region}) = ${m[s.band]} agrees.`, citations: [stp, mainCite] }];
  }
  return [viaPc, { kind: 'rate', rate: mainRate, reason: `${MAIN}!${s.band}${mainRow} (${m.region}) = ${m[s.band]}.`, citations: [mainCite] }];
}

// ---------- combining ----------

const uniqueCitations = (cs: Citation[]) => cs.filter((c, i) => cs.findIndex((o) => o.sheet === c.sheet && o.cell === c.cell) === i);

function summarise(items: { o: Outcome; assumption: string }[], appliesTo: string, base: number | null): RateComponent {
  const rates = items.filter((i): i is { o: Extract<Outcome, { kind: 'rate' }>; assumption: string } => i.o.kind === 'rate');
  const others = items.filter((i) => i.o.kind !== 'rate');
  if (!rates.length && others.every((i) => i.o.kind === 'na')) return notApplicable(appliesTo, others[0].o.reason);
  if (!rates.length && others.every((i) => i.o.kind === 'unsupported')) {
    return unsupported(appliesTo, others[0].o.reason, uniqueCitations(others.flatMap((i) => (i.o.kind === 'unsupported' ? i.o.citations : []))));
  }
  const distinct = [...new Set(rates.map((i) => i.o.rate))];
  if (!others.length && distinct.length === 1) {
    const sameNote = items.length > 1 ? ` Every candidate (${items.length}) gives ${pct(distinct[0])}.` : '';
    return component('applicable', {
      ratePercent: distinct[0],
      appliesTo,
      premiumBase: base,
      reason: rates[0].o.reason + sameNote,
      citations: uniqueCitations(rates.flatMap((i) => i.o.citations)),
    });
  }
  const candidates: RateCandidate[] = distinct.map((rate) => {
    const group = rates.filter((i) => i.o.rate === rate);
    const assumptions = [...new Set(group.map((i) => i.assumption))];
    const shown = assumptions.slice(0, 4).join('; or ') + (assumptions.length > 4 ? `; and ${assumptions.length - 4} more` : '');
    return { ratePercent: rate, assumption: `${shown ? `${shown}: ` : ''}${group[0].o.reason}`, citations: uniqueCitations(group.flatMap((i) => i.o.citations)) };
  });
  const otherNote = [...new Set(others.map((i) => `${i.assumption}: ${i.o.reason}`))].join(' ');
  const result = ambiguousComponent(appliesTo, `More than one grid outcome can apply; see the candidates. ${otherNote}`.trim(), candidates, base);
  return { ...result, citations: uniqueCitations(result.citations) };
}

/** A dimension matters when changing only that choice changes a rate. */
function matters(dimIndex: number, keyed: { idx: number[]; signature: string }[]): boolean {
  const groups = new Map<string, Set<string>>();
  for (const s of keyed) {
    const k = s.idx.map((v, i) => (i === dimIndex ? '*' : v)).join(',');
    if (!groups.has(k)) groups.set(k, new Set());
    groups.get(k)!.add(s.signature);
  }
  return [...groups.values()].some((g) => g.size > 1);
}

const signature = (o: Outcome) => (o.kind === 'rate' ? `${o.rate}` : o.kind);

// ---------- entry point ----------

export function resolve(facts: PolicyFacts): RateResult {
  const trace: TraceStep[] = [];
  const effective = grid.source.effective;
  const gridInfo = {
    file: FILE,
    label: `Reliance Broking Premier FEB 26 Grid - ${PC} (Old Business)`,
    effective: `${effective.from} to ${effective.to}: ${effective.label}`,
  };
  const start = facts.policyStart.value;
  trace.push({
    title: 'Grid effective period',
    detail: `PC = sheet "${PC}". ` + (start
      ? `Policy starts ${start}; the grid is for ${effective.from} to ${effective.to}.${start < effective.from || start > effective.to ? ' The policy date is outside the grid month, so this grid may not be the one that applied when the policy was booked.' : ''}`
      : 'Policy start date not extracted; the effective period cannot be checked.'),
    citations: [cite(MAIN, 'A1', grid.main.text.A1, 'Grid month'), pcNote('A1', 'Private-car sheet title')],
    outcome: start && start >= effective.from && start <= effective.to ? 'ok' : 'warn',
  });

  if (facts.insurer.value && facts.insurer.value !== 'reliance') {
    const reason = `This grid is Reliance General's; the policy is from ${facts.insurer.value}.`;
    trace.push({ title: 'Insurer', detail: reason, outcome: 'stop' });
    return buildResult({
      insurer: facts.insurer.value,
      grid: gridInfo,
      od: unsupported(OD_BASE, reason),
      tp: unsupported(TP_BASE, reason),
      confidence: { level: 'low', reason },
      trace,
    });
  }

  const addons = addonsOf(facts);
  const business = businessDim(facts.businessType);
  const policy = policyDim(facts.policyType);
  trace.push({
    title: 'Business type',
    detail: facts.businessType.value
      ? `${facts.businessType.value}${facts.businessType.note ? `: ${facts.businessType.note}` : '.'} PC!A1 "${grid.pc.text.A1}" covers renewals and rollovers alike${facts.businessType.value === 'new' ? '; new business has no grid' : ''}.`
      : `Not settled; PC!A1 covers Old Business (renewal / rollover) only.`,
    citations: [pcNote('A1', 'Old Business grid')],
    outcome: facts.businessType.value === 'new' ? 'stop' : facts.businessType.value ? 'ok' : 'warn',
  });
  trace.push({
    title: 'Policy type',
    detail: policy.choices.length === 1
      ? `${policy.choices[0].value}: OD from ${policy.choices[0].value === 'saod' ? 'column E (SA OD)' : policy.choices[0].value === 'satp' ? 'none' : 'column C or D by fuel'}, TP from ${policy.choices[0].value === 'package' ? 'PC!H2' : policy.choices[0].value === 'satp' ? 'column F (STP)' : 'none'}.`
      : 'Not settled: package, stand-alone OD and third-party-only use different columns.',
    outcome: policy.choices.length === 1 ? 'ok' : 'warn',
  });

  const geo = geoDim(facts, trace);
  if (typeof geo === 'string') {
    return buildResult({
      insurer: 'reliance',
      grid: gridInfo,
      od: unsupported(OD_BASE, geo),
      tp: unsupported(TP_BASE, geo),
      confidence: { level: 'low', reason: geo },
      trace,
      questions: [QUESTIONS.rtoCode!],
    });
  }

  const fuel = fuelDim(facts.fuel);
  const cc = ccDim(facts.cc);
  const fuelNote = facts.fuel.status === 'derived' ? ` ${facts.fuel.note}` : facts.fuel.status === 'user' ? ' Answered by the user.' : '';
  trace.push({
    title: 'Fuel',
    detail: fuel.choices.length === 1
      ? `${facts.fuel.value ?? facts.fuel.candidates?.join(' / ')} -> ${fuel.choices[0].assumption}.${fuelNote}`
      : `Fuel not settled (${facts.fuel.note ?? facts.fuel.status}); candidates: ${fuel.choices.map((c) => c.assumption).join(' / ')}.`,
    citations: fuel.choices.flatMap((c) => c.citations),
    outcome: fuel.choices.length === 1 && facts.fuel.status !== 'derived' ? 'ok' : 'warn',
  });
  const h3 = facts.cc.value !== null && facts.cc.value < 1000;
  trace.push({
    title: 'Cubic capacity (PC!H3)',
    detail: facts.cc.value === null
      ? 'cc not extracted: below 1000 cc takes 5 points off (PC!H3).'
      : h3
        ? `${facts.cc.value} cc is below 1000, so PC!H3 "${grid.pc.text.H3}" applies. Interpretation: read as 5 percentage points off, as every other adjustment in this workbook is in points; 5% of the rate (x 0.95) is the alternative reading.`
        : `${facts.cc.value} cc: PC!H3 does not apply.`,
    citations: [pcNote('H3', 'cc below 1000: 5 points less')],
    outcome: facts.cc.value === null || h3 ? 'warn' : 'ok',
  });
  const packageZd = addons.zeroDep && policy.choices.some((c) => c.value === 'package');
  trace.push({
    title: 'Add-on modifiers (PC!H4, PC!H6)',
    detail: !addons.known
      ? 'Opted add-ons not extracted: PC!H4 (stand-alone OD with zero depreciation, -2.5) and PC!H6 (Tyre / RTI, +2.5) were not applied.'
      : `${addons.tyreOrRti ? 'Tyre / RTI add-on present: +2.5 points (PC!H6).' : 'No Tyre Protector or Return to Invoice add-on: PC!H6 not applied.'} ${packageZd ? 'Zero depreciation is on a package policy; PC!H4 is read as applying to stand-alone OD only, so it is not applied (the broad reading would take 2.5 points more).' : addons.zeroDep ? 'Zero depreciation on stand-alone OD: -2.5 points (PC!H4).' : 'No zero-depreciation add-on.'}`,
    citations: [pcNote('H4', 'Stand-alone OD with zero depreciation'), pcNote('H6', 'Tyre / RTI add-on bundle')],
    outcome: !addons.known || packageZd ? 'warn' : 'ok',
  });

  // Rate every combination of the open choices.
  const dims = [business, policy, geo, fuel, cc] as const;
  const keyed: { idx: number[]; signature: string; od: Outcome; tp: Outcome[]; assumption: string }[] = [];
  business.choices.forEach((b, bi) => policy.choices.forEach((p, pi) => geo.choices.forEach((g, gi) => fuel.choices.forEach((fu, fi) => cc.choices.forEach((c, ci) => {
    const s: Scenario = { business: b.value, policy: p.value, geo: g.value, fuel: fu.value, band: c.value };
    const od = rateOd(s, addons);
    const tp = rateTp(s);
    const picked = [b, p, g, fu, c].filter((_, i) => dims[i].choices.length > 1).map((x) => x.assumption);
    keyed.push({ idx: [bi, pi, gi, fi, ci], signature: [od, ...tp].map(signature).join('|'), od, tp, assumption: picked.join(', ') });
  })))));
  const withGeo = (o: Outcome, gi: number): Outcome => (o.kind === 'rate' ? { ...o, citations: [...geo.choices[gi].citations, ...o.citations] } : o);
  const od = summarise(keyed.map((k) => ({ o: withGeo(k.od, k.idx[2]), assumption: k.assumption })), OD_BASE, facts.premium.netOd.value);
  const tp = summarise(keyed.flatMap((k) => k.tp.map((o) => ({ o: withGeo(o, k.idx[2]), assumption: k.assumption }))), TP_BASE, facts.premium.netTp.value);
  const questions = dims.flatMap((d, i) => (d.fact && d.choices.length > 1 && matters(i, keyed) ? [QUESTIONS[d.fact]!] : []));

  trace.push({
    title: 'TP basis',
    detail: tp.reason,
    citations: tp.citations,
    outcome: tp.applicability === 'ambiguous' ? 'warn' : 'ok',
  });
  trace.push({
    title: 'Not grid dimensions',
    detail: `Vehicle age (${facts.vehicleAgeYears.value ?? 'n/a'} years), NCB (${facts.ncbPercent.value ?? 'n/a'}%) and make/model segment (${[facts.make.value, facts.model.value].filter(Boolean).join(' ') || 'n/a'}) are not dimensions of PC or ${MAIN}!AR:AT, so they do not change the rate.`,
    outcome: 'ok',
  });
  trace.push({
    title: 'Hygiene rules (not applied)',
    detail: `${grid.hygiene.sheet}!A44:A48 are post-issue claw-backs (premium dishonour, risk-attribute discrepancy, missing CPA, falsified NCB). ${addons.known ? (addons.cpa ? 'CPA is on the policy, so A47 (1% deduction without CPA) does not bite.' : 'No CPA on the policy: A47 deducts 1% from the overall payout.') : 'CPA presence unknown.'}`,
    citations: [cite(grid.hygiene.sheet, 'A47', grid.hygiene.rules.A47, 'CPA mandatory, else 1% deducted')],
    outcome: addons.known && addons.cpa ? 'ok' : 'warn',
  });
  if (od.applicability === 'ambiguous' || tp.applicability === 'ambiguous') {
    trace.push({
      title: 'Open choices',
      detail: questions.length
        ? `The rate changes with ${questions.map((q) => q.fact).join(' and ')}; answer the question(s) to resolve.`
        : 'The grid itself does not decide between the candidates (no fact answer settles it).',
      outcome: 'warn',
    });
  } else if (keyed.length > 1) {
    trace.push({ title: 'Open choices', detail: `${keyed.length} combinations of the unsettled facts all give the same rates, so the result is resolved.`, outcome: 'ok' });
  }

  return buildResult({ insurer: 'reliance', grid: gridInfo, od, tp, confidence: confidence(facts, policy, h3 || packageZd), trace, questions });
}

/** high: decisive facts printed; medium: one derived or missing, or an interpretation call; low: several. */
function confidence(facts: PolicyFacts, policy: Dim<PolicyType>, interpretation: boolean): RateResult['confidence'] {
  const isPackage = policy.choices.some((c) => c.value === 'package');
  const decisive: [string, Fact<unknown>][] = [
    ['policy type', facts.policyType],
    ['registration / RTO', facts.rtoCode.status === 'user' || !facts.registrationNumber.value ? facts.rtoCode : facts.registrationNumber],
    ...(isPackage ? [['fuel', facts.fuel] as [string, Fact<unknown>]] : []),
    ...(policy.choices.some((c) => c.value !== 'satp') ? [['cc', facts.cc] as [string, Fact<unknown>]] : []),
  ];
  const weak = decisive.filter(([, f]) => f.value === null || f.status === 'derived').map(([n, f]) => `${n} ${f.value === null ? 'not known' : 'derived'}`);
  const parts = [...weak, ...(interpretation ? ['a grid footnote needed an interpretation call'] : [])];
  const level = weak.length >= 2 ? 'low' : parts.length ? 'medium' : 'high';
  return { level, reason: parts.length ? `${parts.join('; ')}.` : 'Every decisive fact was printed and read cleanly.' };
}
