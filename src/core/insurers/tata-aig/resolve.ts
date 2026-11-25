// Deterministic Tata AIG private-car lookup against the normalised Pvtcar grid (spec: specs/tata-aig.md).
// Every unknown dimension expands to its candidate set; the cross product of cells decides:
// one non-zero value -> resolved, all 0 -> declined, anything else -> ambiguous with a question.
import grid from '../../../data/grids/tata-aig.json';
import { squash } from '../../geo';
import type {
  Citation,
  ClarifyingQuestion,
  Fact,
  PolicyFacts,
  RateCandidate,
  RateComponent,
  RateResult,
  TraceStep,
} from '../../types';
import { ambiguousComponent, buildResult, component, notApplicable, pct, toPercent, unsupported } from '../module';
import { locate } from './location';

type Row = (typeof grid.rows)[number];
type Location = (typeof grid.locations)[number];
type RowDim = 'segment' | 'businessType' | 'fuel' | 'section' | 'ncb' | 'addOn';
type Dim = RowDim | 'location';
type Dims = Record<Dim, string[]>;

interface Cell { row: Row; loc: Location; rate: number; ref: string }

interface Pick {
  values: string[];
  detail: string;
  citations: Citation[];
  question?: ClarifyingQuestion;
  /** Set when the value came from a derived fact: the values it would take otherwise (robustness check). */
  alternatives?: string[];
}

const FILE = grid.source.file;
const ROW_DIMS: RowDim[] = ['segment', 'businessType', 'fuel', 'section', 'ncb', 'addOn'];
const DIM_NAME: Record<Dim, string> = {
  segment: 'segment', businessType: 'business type', fuel: 'fuel', section: 'section', ncb: 'NCB', addOn: 'add-on', location: 'location',
};
const SEGMENTS = ['Mini', 'Compact', 'Mid Size', 'MPV SUV', 'High End', 'Ultra High End', 'Quadricycle'];
const HEADERS = grid.locations.map((l) => l.name);
const OD_BASE = 'OD premium';
const TP_BASE = 'Net premium (before GST, incl. CNG/LPG-kit TP and PA owner-driver)';

function cite(ref: string, value: string | number | null, label: string): Citation {
  const [sheet, cell] = ref.split('!');
  return { file: FILE, sheet, cell, value, label };
}

const rule = (ref: keyof typeof grid.notes, label: string) => cite(ref, grid.notes[ref], label);
const header = (col: string, text: string) => cite(`Pvtcar!${col}5`, text, `${text.trim()} header`);
const BASIS = [rule('Pvtcar!F2', 'premium basis per section'), rule('General Guidelines!C7', 'premium basis per section')];

const known = <T>(f: Fact<T>): T | null => (f.value !== null && f.status !== 'missing' && f.status !== 'ambiguous' ? f.value : null);
const derived = (f: Fact<unknown>) => f.status === 'derived';
const percent = (rate: number) => toPercent(rate, true);

function lookup(d: Dims): Cell[] {
  const locs = grid.locations.flatMap((loc, i) => (d.location.includes(loc.name) ? [{ loc, i }] : []));
  return grid.rows
    .filter((row) => ROW_DIMS.every((k) => d[k].includes(row[k])))
    .flatMap((row) => locs.map(({ loc, i }) => ({ row, loc, rate: row.rates[i], ref: `Pvtcar!${loc.col}${row.row}` })));
}

const valueOf = (c: Cell, d: Dim) => (d === 'location' ? c.loc.name : c.row[d]);
const rates = (cells: Cell[]) => [...new Set(cells.map((c) => c.rate))].sort((a, b) => a - b);

function cellCitation(c: Cell): Citation {
  const r = c.row;
  return cite(c.ref, c.rate, `${r.businessType} / ${r.segment} / ${r.fuel} / ${r.section} / NCB ${r.ncb} / Add On ${r.addOn} @ ${c.loc.name} = ${pct(percent(c.rate))}`);
}

/** True when the rate depends on which value of `d` applies. */
function varies(cells: Cell[], d: Dim): boolean {
  const byValue = new Map<string, Set<number>>();
  for (const c of cells) byValue.set(valueOf(c, d), (byValue.get(valueOf(c, d)) ?? new Set()).add(c.rate));
  return new Set([...byValue.values()].map((s) => [...s].sort().join())).size > 1;
}

function candidates(cells: Cell[]): RateCandidate[] {
  const open = (Object.keys(DIM_NAME) as Dim[]).filter((d) => new Set(cells.map((c) => valueOf(c, d))).size > 1);
  return rates(cells).map((rate) => {
    const group = cells.filter((c) => c.rate === rate);
    const assumption = open.map((d) => `${DIM_NAME[d]} ${[...new Set(group.map((c) => valueOf(c, d)))].join(' / ')}`).join('; ');
    return {
      ratePercent: percent(rate),
      assumption: `${assumption || 'every candidate'}${rate === 0 ? ' (0% = declined)' : ''}`,
      citations: group.map(cellCitation),
    };
  });
}

// ---- dimension picks (spec §3.1 - §3.6) ----

function pickSection(facts: PolicyFacts): Pick {
  const t = known(facts.policyType);
  const citations = [header('J', 'Section Text '), ...BASIS];
  if (t === null) {
    return {
      values: ['Package', 'SAOD', 'SATP'], citations,
      detail: 'Policy type not established: Package, SAOD and SATP rows are all candidates.',
      question: {
        fact: 'policyType', question: 'Which cover does the policy carry?',
        options: [
          { value: 'package', label: 'Package / comprehensive (OD + TP)' },
          { value: 'satp', label: 'Stand-alone third party (liability only)' },
          { value: 'saod', label: 'Stand-alone own damage' },
        ],
      },
    };
  }
  const section = { package: 'Package', satp: 'SATP', saod: 'SAOD' }[t];
  const basis = section === 'SATP' ? 'the TP rate applies to net premium and OD is not applicable' : 'the rate applies to OD premium and TP is not applicable';
  return { values: [section], citations, detail: `Policy type ${t} -> Section Text "${section}"; ${basis} (Pvtcar!F2, General Guidelines!C7).` };
}

function pickBusinessType(facts: PolicyFacts): Pick {
  const b = known(facts.businessType);
  const citations = [header('H', 'Business Type')];
  const note = facts.businessType.note ? ` ${facts.businessType.note}` : '';
  if (b === null) {
    const used = (known(facts.vehicleAgeYears) ?? 0) >= 1 || known(facts.previousInsurer) !== null;
    return {
      values: used ? ['Renewal', 'Rollover'] : ['Brand New', 'Renewal', 'Rollover'], citations,
      detail: `Business type unknown${used ? ' on a used vehicle: Renewal and Rollover' : ': every business type'} evaluated.`,
      question: {
        fact: 'businessType', question: 'Was the previous policy with Tata AIG (renewal), another insurer (rollover), or is the car brand new?',
        options: [{ value: 'renewal', label: 'Renewal (previous insurer Tata AIG)' }, { value: 'rollover', label: 'Rollover (another insurer)' }, { value: 'new', label: 'Brand new' }],
      },
    };
  }
  const value = { new: 'Brand New', renewal: 'Renewal', rollover: 'Rollover' }[b];
  return {
    values: [value], citations,
    detail: `Business type ${b} -> "${value}". The grid has no break-in dimension.${note}`,
    ...(derived(facts.businessType) && b !== 'new' ? { alternatives: ['Renewal', 'Rollover'].filter((v) => v !== value) } : {}),
  };
}

function pickFuel(facts: PolicyFacts): Pick {
  const fuel = known(facts.fuel);
  const kit = known(facts.cngLpgKit) === true;
  const citations = [header('I', 'Fuel Type')];
  const all = ['Diesel', 'CNG', 'Electric', 'Other Than Diesel'];
  const question = (q: string, options: [string, string][]): ClarifyingQuestion => ({
    fact: 'fuel', question: q, options: options.map(([value, label]) => ({ value, label })),
  });
  if (fuel === 'lpg') {
    return {
      values: ['Other Than Diesel', 'CNG'], citations,
      detail: 'LPG: the grid has no LPG row, so "Other Than Diesel" (literal) and "CNG" (gas-kit reading) are both candidates.',
      question: question('Pvtcar has no LPG row. Rate this LPG car on the CNG row or the Other Than Diesel row?', [['cng', 'CNG row (gas kit)'], ['petrol', 'Other Than Diesel row']]),
    };
  }
  if (fuel === null && !kit) {
    return {
      values: all, citations, detail: 'Fuel not established: every fuel row is a candidate.',
      question: question('What fuel does the car run on?', [['petrol', 'Petrol'], ['diesel', 'Diesel'], ['cng', 'CNG'], ['electric', 'Electric']]),
    };
  }
  if ((fuel === null || fuel === 'petrol') && kit) {
    return { values: ['CNG'], citations, alternatives: ['Other Than Diesel'], detail: 'CNG/LPG kit on the policy (IMT 25) -> "CNG", the most specific row.' };
  }
  const value = { diesel: 'Diesel', cng: 'CNG', electric: 'Electric', petrol: 'Other Than Diesel', hybrid: 'Other Than Diesel' }[fuel ?? 'petrol'];
  const hybrid = fuel === 'hybrid' ? ' Hybrid has no row of its own; rated as non-diesel, non-BEV.' : '';
  return {
    values: [value], citations, detail: `Fuel ${fuel} -> "${value}".${hybrid}`,
    ...(derived(facts.fuel) || fuel === 'hybrid' ? { alternatives: all.filter((v) => v !== value) } : {}),
  };
}

function pickNcb(facts: PolicyFacts): Pick {
  const ncb = known(facts.ncbPercent);
  const citations = [header('K', 'NCB')];
  if (ncb === null) {
    return {
      values: ['All', 'Yes', 'No'], citations,
      detail: 'Current NCB not established; it only matters on Renewal/Rollover Package and SAOD rows (others are "All").',
      question: { fact: 'ncbPercent', question: 'What NCB % does the current policy give on own damage? (0 if none)' },
    };
  }
  return { values: ['All', ncb > 0 ? 'Yes' : 'No'], citations, detail: `Current NCB ${ncb}% -> "${ncb > 0 ? 'Yes' : 'No'}" on Renewal/Rollover Package and SAOD rows, "All" elsewhere.` };
}

function pickAddOn(): Pick {
  return {
    values: ['All', 'Yes', 'No'], citations: [header('L', 'Add On')],
    detail: 'Add-on covers are not a policy fact here, so Yes and No are both evaluated where the row splits on them ("All" elsewhere).',
  };
}

function pickSegment(facts: PolicyFacts): Pick {
  const model = known(facts.model) ?? '';
  const vehicle = `${known(facts.make) ?? ''} ${model}`.trim() || 'this vehicle';
  const citations = [header('G', 'Type')];
  const answered = facts.model.status === 'user' ? SEGMENTS.find((s) => squash(s) === squash(model)) : undefined;
  if (answered) return { values: [answered], citations, detail: `Segment "${answered}" given by the user.` };
  if (/quadri|qute/i.test(vehicle)) return { values: ['Quadricycle'], citations, detail: `${vehicle} is named a quadricycle -> "Quadricycle".` };
  return {
    values: SEGMENTS, citations,
    detail: `The workbook has no make/model -> segment table, so the segment of ${vehicle} is unknown and all 7 segment rows are evaluated (never guessed from cc or body type).`,
    question: {
      fact: 'model', question: `Tata AIG publishes no make/model segment list. Which Pvtcar segment is ${vehicle}?`,
      options: SEGMENTS.map((s) => ({ value: s, label: s })),
    },
  };
}

function pickLocation(facts: PolicyFacts): Pick {
  const loc = locate(facts, HEADERS);
  const citations = [
    ...(loc.unknown ? [] : loc.columns.map((name) => header(grid.locations.find((l) => l.name === name)!.col, name))),
    rule('General Guidelines!C10', 'RTO on the policy decides the location'),
  ];
  return {
    values: loc.columns, citations, detail: loc.detail,
    ...(loc.columns.length > 1 ? {
      question: {
        fact: 'rtoLocation' as const,
        question: 'Which Pvtcar location column covers the RTO the car is registered at?',
        ...(loc.unknown ? {} : { options: loc.columns.map((c) => ({ value: c, label: c })) }),
      },
    } : {}),
  };
}

// ---- evaluation ----

interface Evaluated { component: RateComponent; cells: Cell[]; questions: ClarifyingQuestion[] }

function evaluate(picks: Record<Dim, Pick>, sections: string[], appliesTo: string, base: number | null, forceAmbiguous: boolean): Evaluated {
  const dims = Object.fromEntries((Object.keys(picks) as Dim[]).map((d) => [d, d === 'section' ? sections : picks[d].values])) as Dims;
  const cells = lookup(dims);
  const found = rates(cells);
  if (cells.length === 0) {
    const reason = `No Pvtcar row for ${(Object.keys(dims) as Dim[]).map((d) => `${DIM_NAME[d]} ${dims[d].join('/') || 'none'}`).join(', ')}.`;
    return { component: unsupported(appliesTo, reason), cells, questions: [] };
  }
  if (found.length === 1 && found[0] === 0) {
    const refs = cells.map((c) => c.ref);
    const reason = `DECLINED: grid publishes 0% at ${refs.slice(0, 7).join(', ')}${refs.length > 7 ? ` and ${refs.length - 7} more` : ''}.`;
    return { component: unsupported(appliesTo, reason, cells.map(cellCitation)), cells, questions: [] };
  }
  if (found.length === 1 && !forceAmbiguous) {
    const rate = percent(found[0]);
    const many = cells.length > 1 ? ` (all ${cells.length} candidate cells agree)` : '';
    return {
      component: component('applicable', {
        ratePercent: rate, appliesTo, premiumBase: base, reason: `${pct(rate)} of ${appliesTo}${many}.`,
        citations: [...cells.map(cellCitation), ...picks.location.citations, ...BASIS],
      }),
      cells, questions: [],
    };
  }
  const questions = (Object.keys(picks) as Dim[])
    .filter((d) => picks[d].question && (varies(cells, d) || (d === 'section' && forceAmbiguous)))
    .map((d) => picks[d].question!);
  const reason = forceAmbiguous
    ? 'The policy type is not established, so it is unclear whether this component applies.'
    : `Candidate cells disagree (${found.map((r) => pct(percent(r))).join(' / ')}); ${questions.length ? 'answer the question to pick one' : 'the deciding dimension is not a policy fact'}.`;
  return { component: ambiguousComponent(appliesTo, reason, candidates(cells), base), cells, questions };
}

function validityStep(facts: PolicyFacts): TraceStep {
  const start = known(facts.policyStart);
  const { from, label } = grid.source.effective;
  const citations = [rule('Pvtcar!F1', 'grid effective date')];
  if (!start) return { title: 'Grid validity', detail: `Policy start date unknown; cannot check against ${label}.`, citations, outcome: 'warn' };
  if (start < from) return { title: 'Grid validity', detail: `Policy starts ${start}, before the grid's effective date ${from} (${label}).`, citations, outcome: 'warn' };
  return { title: 'Grid validity', detail: `Policy starts ${start}, on or after ${from} (${label}).`, citations, outcome: 'ok' };
}

function tenureDays(facts: PolicyFacts): number | null {
  const start = known(facts.policyStart);
  const end = known(facts.policyEnd);
  return start && end ? (Date.parse(end) - Date.parse(start)) / 86_400_000 : null;
}

export function resolve(facts: PolicyFacts): RateResult {
  const gridInfo = { file: FILE, label: "Tata AIG Standard Grid (Mar'26), sheet Pvtcar", effective: `${grid.source.effective.from} onwards (${grid.source.effective.label})` };
  const trace: TraceStep[] = [];

  if (known(facts.insurer) !== 'tata-aig') {
    const reason = `Insurer is ${known(facts.insurer) ?? 'unknown'}, not Tata AIG: this grid does not apply.`;
    trace.push({ title: 'Insurer', detail: reason, outcome: 'stop' });
    return buildResult({
      insurer: known(facts.insurer), grid: gridInfo, od: unsupported(OD_BASE, reason), tp: unsupported(TP_BASE, reason),
      confidence: { level: 'high', reason: 'Insurer mismatch.' }, trace,
    });
  }
  trace.push({
    title: 'Insurer and sheet',
    detail: 'Tata AIG -> Standard Grid, sheet Pvtcar (private car). CV, TW and Extended Warranty sheets do not apply; the hidden pivot sheets are stale and never read.',
    citations: [rule('Pvtcar!F1', 'private-car grid title')], outcome: 'ok',
  });
  trace.push(validityStep(facts));
  trace.push({
    title: 'Deal overrides',
    detail: 'Calculation sequence is policy, fleet, PAN and code-specific deals before the standard grid; none is in the corpus, so the standard grid applies (C17). Rates are base commission only: the GWP-based incremental rule is not published in the workbook.',
    citations: [rule('General Guidelines!C11', 'calculation sequence'), rule('General Guidelines!C16', 'standard grid is the last step'),
      rule('General Guidelines!C17', 'default to standard grid'), rule('Pvtcar!F3', 'base commission only'), rule('General Guidelines!C5', 'base commission only')],
    outcome: 'warn',
  });

  const picks: Record<Dim, Pick> = {
    section: pickSection(facts), businessType: pickBusinessType(facts), fuel: pickFuel(facts),
    ncb: pickNcb(facts), addOn: pickAddOn(), location: pickLocation(facts), segment: pickSegment(facts),
  };
  for (const d of ['section', 'businessType', 'fuel', 'ncb', 'addOn', 'location', 'segment'] as Dim[]) {
    trace.push({ title: `Dimension: ${DIM_NAME[d]}`, detail: picks[d].detail, citations: picks[d].citations, outcome: picks[d].values.length ? 'ok' : 'stop' });
  }

  const netPremium = known(facts.premium.netPremium);
  const netOd = known(facts.premium.netOd);
  const sectionKnown = picks.section.values.length === 1;
  const odSections = picks.section.values.filter((s) => s !== 'SATP');
  const tpSections = picks.section.values.filter((s) => s === 'SATP');
  const questions: ClarifyingQuestion[] = [];
  const allCells: Cell[] = [];

  const run = (sections: string[], appliesTo: string, base: number | null, other: string): RateComponent => {
    if (!sections.length) return notApplicable(appliesTo, other, BASIS);
    if (picks.location.values.length === 0) return unsupported(appliesTo, `No location column reachable: ${picks.location.detail}`, picks.location.citations);
    if (picks.businessType.values.join() === 'Brand New' && sections.join() === 'SAOD') {
      return unsupported(appliesTo, 'Brand New + SAOD: the grid has no such rows (a new car cannot carry stand-alone OD).');
    }
    const days = tenureDays(facts);
    if (sections.join() === 'SATP' && days !== null && days > 400) {
      return unsupported(appliesTo, `Long-term TP (${Math.round(days)} days): LTTP is not considered for payout % (General Guidelines!C9).`, [rule('General Guidelines!C9', 'LTTP excluded from payout')]);
    }
    const out = evaluate(picks, sections, appliesTo, base, !sectionKnown);
    questions.push(...out.questions);
    allCells.push(...out.cells);
    return out.component;
  };

  const od = run(odSections, OD_BASE, netOd, 'SATP: the policy has no own-damage premium, so there is no OD component (never 0%).');
  const tp = run(tpSections, TP_BASE, netPremium,
    'Package/SAOD payout is on OD premium only (Pvtcar!F2, General Guidelines!C7); the grid publishes no TP %.');

  const tenure = tenureDays(facts);
  trace.push({
    title: 'LTTP rule',
    detail: tenure === null ? 'Policy period unknown; LTTP (C9) could not be checked.' : tenure > 400 ? `TP tenure ${Math.round(tenure)} days > 1 year: LTTP earns no payout.` : `TP tenure ${Math.round(tenure)} days (1 year): C9 does not apply.`,
    citations: [rule('General Guidelines!C9', 'LTTP excluded from payout')],
    outcome: tenure === null ? 'warn' : tenure > 400 ? 'stop' : 'ok',
  });

  for (const [name, c] of [['OD', od], ['TP', tp]] as const) {
    const outcome = c.applicability === 'applicable' || c.applicability === 'not_applicable' ? 'ok' : c.applicability === 'ambiguous' ? 'warn' : 'stop';
    const rateText = c.applicability === 'applicable' ? `${pct(c.ratePercent)} - ` : '';
    trace.push({ title: `${name} rate`, detail: `${rateText}${c.reason}`, citations: c.citations, outcome });
  }

  // Robustness: a dimension set from a derived fact only counts against confidence if its alternatives change the rate.
  const calls: string[] = [];
  if (sectionKnown && derived(facts.policyType)) calls.push('policy type derived from the premium schedule');
  if (allCells.length) {
    const sections = [...new Set(allCells.map((c) => c.row.section))];
    for (const d of ROW_DIMS) {
      const alt = picks[d].alternatives;
      if (!alt) continue;
      const dims = Object.fromEntries((Object.keys(picks) as Dim[]).map((k) => [k, k === 'section' ? sections : picks[k].values])) as Dims;
      const wider = lookup({ ...dims, [d]: [...dims[d], ...alt] });
      const same = rates(wider).join() === rates(allCells).join();
      if (!same) calls.push(`${DIM_NAME[d]} "${picks[d].values.join()}" is an interpretation and ${alt.join('/')} would change the rate`);
      trace.push({
        title: `Robustness: ${DIM_NAME[d]}`,
        detail: same
          ? `${DIM_NAME[d]} came from a derived fact; ${alt.join('/')} gives the same rate (${wider.filter((c) => alt.includes(valueOf(c, d))).map((c) => c.ref).join(', ')}), so it is moot.`
          : `${DIM_NAME[d]} came from a derived fact and ${alt.join('/')} would give ${rates(wider).map((r) => pct(percent(r))).join(' / ')}.`,
        citations: wider.filter((c) => alt.includes(valueOf(c, d))).map(cellCitation),
        outcome: same ? 'ok' : 'warn',
      });
    }
  }

  const open = [od, tp].some((c) => c.applicability === 'ambiguous');
  const confidence: RateResult['confidence'] = open
    ? { level: 'low', reason: 'The rate depends on unanswered questions.' }
    : calls.length === 0
      ? { level: 'high', reason: 'Every decisive fact was printed and read cleanly; candidate dimensions that were unknown all give the same cell value.' }
      : { level: calls.length === 1 ? 'medium' : 'low', reason: `Interpretation calls: ${calls.join('; ')}.` };

  const unique = questions.filter((q, i) => questions.findIndex((x) => x.fact === q.fact) === i);
  return buildResult({ insurer: 'tata-aig', grid: gridInfo, od, tp, confidence, trace, questions: unique });
}
