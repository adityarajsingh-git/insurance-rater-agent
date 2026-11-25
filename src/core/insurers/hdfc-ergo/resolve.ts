// Deterministic HDFC ERGO grid lookup (spec: specs/hdfc-ergo.md). The grid has five dimensions - zone,
// category (Package/SAOD), fuel group, NCB column and the broker's GWP slab. Each is narrowed from policy
// facts (or user answers); the remaining combinations are enumerated, and only the dimensions that actually
// change the rate become clarifying questions.
import grid from '../../../data/grids/hdfc-ergo.json';
import { squash, stateCodeFromName, stateFromCode } from '../../geo';
import { yearsBetween } from '../../extract/common';
import type { Citation, ClarifyingQuestion, Fact, FactKey, PolicyFacts, RateCandidate, RateComponent, RateResult, TraceStep } from '../../types';
import { ambiguousComponent, buildResult, component, notApplicable, pct, unsupported } from '../module';

type Rate = (typeof grid.rates)[number];
type ZoneCell = (typeof grid.zoneMap)[number];
const DIMS = ['zone', 'category', 'fuel', 'ncb', 'slab'] as const;
type Dim = (typeof DIMS)[number];
type Pick = Record<Dim, string>;

/**
 * The broker's achieved GWP slab is a business-volume input, not a policy fact, so it has no PolicyFacts key.
 * It lives in PolicyFacts.gwpSlab, which extraction always leaves missing; only a user answer fills it.
 */
export const SLAB_FACT: FactKey = 'gwpSlab';

const FILE = grid.source.file;
const OD_BASE = 'Net own-damage premium (incl. add-ons)';
const TP_BASE = 'Net liability premium';
const GRID: RateResult['grid'] = {
  file: FILE,
  label: "HDFC ERGO private car grid (Pvt Car New Grid Eff 1st Feb'25)",
  effective: `from ${grid.source.effective.from} (no end date printed)`,
};
// Union territories the grid lists as places inside another state's row.
const UT_PLACE: Record<string, string> = { AN: 'ANDAMANS', DN: 'DADRA & NAGAR HAVELI', DD: 'DAMAN' };
// ponytail: two common spellings only; add an RTO-code list if split-state locations keep missing.
const PLACE_ALIASES: [RegExp, string][] = [[/bengaluru/, 'bangalore'], [/baroda/, 'vadodara']];

interface Dimension {
  values: string[];
  step: TraceStep;
  question?: ClarifyingQuestion;
  soft?: string; // interpretation call or derived fact behind the decision (lowers confidence)
  stop?: string; // unsupported reason
}

// ---------- citations ----------

const footnote = (key: keyof typeof grid.footnotes, label: string): Citation => ({
  file: FILE, page: grid.footnotes[key].page, table: 'Footnotes', row: key, value: grid.footnotes[key].text, label,
});
const zoneCite = (z: ZoneCell, label: string): Citation => ({
  file: FILE, page: z.page, table: 'State to zone mapping', row: z.stateText, column: z.column, value: z.place, label,
});
const rateCite = (r: Rate): Citation => ({
  file: FILE, page: r.page, table: `${r.zone} rates`, row: r.slab, column: r.column, value: r.raw,
  label: `${r.zone} · ${r.column} · slab ${r.slab}`,
});
const CATEGORY_HEADER: Citation = {
  file: FILE, page: 1, table: 'Zone 1 rates', row: 'Header', column: 'Category', value: 'Package | SAOD',
  label: 'The grid publishes Package and SAOD categories only',
};
const EFFECTIVE: Citation = {
  file: FILE, page: grid.source.effective.page, table: 'Header', value: grid.source.effective.text, label: 'Grid effective date',
};
const MAP_HEADER: Citation = {
  file: FILE, page: 1, table: 'State to zone mapping', row: 'Header', value: 'Zone | State Name | Zone-1 | Zone-2',
  label: 'States the grid assigns to a zone',
};

const quote = (f: Fact<unknown>) => {
  const e = f.evidence[0];
  return e ? ` (${e.page ? `p${e.page} ` : ''}"${e.quote.slice(0, 80)}")` : '';
};
const unique = <T>(xs: T[]) => [...new Set(xs)];

// ---------- dimensions ----------

function validity(facts: PolicyFacts): TraceStep {
  const from = grid.source.effective.from;
  const start = facts.policyStart.value;
  const base = { title: 'Check the grid is in force', citations: [EFFECTIVE] };
  if (!start) return { ...base, detail: `Grid effective from ${from}, no end date printed. Policy start not extracted, so validity was not checked.`, outcome: 'warn' };
  if (start < from) return { ...base, detail: `Policy starts ${start}, before the grid's effective date ${from}. Used anyway: it is the only HDFC ERGO grid in the corpus.`, outcome: 'warn' };
  if (yearsBetween(from, start) >= 1) {
    return { ...base, detail: `Grid effective from ${from} with no end date; policy starts ${start}, more than a year later, so a newer HDFC ERGO grid may apply. None is in the corpus, so this one is used.`, outcome: 'warn' };
  }
  return { ...base, detail: `Grid effective from ${from}; policy starts ${start}.`, outcome: 'ok' };
}

function categoryDim(facts: PolicyFacts): Dimension {
  const t = facts.policyType;
  const title = 'Policy type to grid category';
  if (t.value === 'satp') {
    return {
      values: [],
      stop: 'This grid publishes Package and SAOD rates only - there is no SATP rate, and its slab footnote excludes SATP premium. Not declined, just not covered.',
      step: { title, detail: `Stand-alone TP policy${quote(t)}: no SATP category in the grid.`, citations: [CATEGORY_HEADER, footnote('slab', 'SATP premium is outside this grid')], outcome: 'stop' },
    };
  }
  if (t.value === 'package' || t.value === 'saod') {
    const cat = t.value === 'package' ? 'Package' : 'SAOD';
    return {
      values: [cat],
      soft: t.status === 'derived' ? `policy type inferred (${t.note})` : undefined,
      step: { title, detail: `${t.value}${quote(t)} → ${cat} columns.`, citations: [CATEGORY_HEADER], outcome: 'ok' },
    };
  }
  return {
    values: ['Package', 'SAOD'],
    question: {
      fact: 'policyType',
      question: 'Is this a package (comprehensive), stand-alone OD or stand-alone TP policy?',
      options: [{ value: 'package', label: 'Package / comprehensive' }, { value: 'saod', label: 'Stand-alone OD' }, { value: 'satp', label: 'Stand-alone TP' }],
    },
    step: { title, detail: `Policy type not found (${t.note}); both Package and SAOD columns are considered.`, citations: [CATEGORY_HEADER], outcome: 'warn' },
  };
}

function placeMatches(location: string, place: string): boolean {
  const loc = PLACE_ALIASES.reduce((s, [re, to]) => s.replace(re, to), squash(location));
  return loc.includes(squash(place));
}

function zoneDim(facts: PolicyFacts): Dimension {
  const title = 'Registration to zone';
  const fromRto = facts.rtoCode.value?.slice(0, 2).toUpperCase();
  const code = fromRto && stateFromCode(fromRto) ? fromRto : facts.state.value ? stateCodeFromName(facts.state.value) : null;
  const rtoQuestion: ClarifyingQuestion = { fact: 'rtoCode', question: 'What is the RTO code of the registration (for example HR-26)?' };
  if (!code) {
    return {
      values: ['Zone 1', 'Zone 2'],
      question: rtoQuestion,
      step: { title, detail: `RTO code "${facts.rtoCode.value ?? 'not extracted'}" and state "${facts.state.value ?? 'not extracted'}" give no known state; both zones are considered.`, citations: [MAP_HEADER], outcome: 'warn' },
    };
  }
  const via = fromRto === code ? `RTO ${facts.rtoCode.value}${quote(facts.rtoCode)}` : `state ${facts.state.value}${quote(facts.state)}`;
  const viaSoft = fromRto === code ? undefined : `zone taken from the state fact, the RTO code ${facts.rtoCode.value ?? '(none)'} is not a known registration code`;
  const stateName = stateFromCode(code)!;
  const ut = UT_PLACE[code];
  const cells = ut ? grid.zoneMap.filter((z) => z.place === ut) : grid.zoneMap.filter((z) => z.state === stateName);
  if (!cells.length) {
    return {
      values: [],
      stop: `The grid's state-to-zone table has no entry for ${stateName} (${code}).`,
      step: { title, detail: `${via} → ${stateName}: not listed in the state-to-zone table.`, citations: [MAP_HEADER], outcome: 'stop' },
    };
  }
  const zones = unique(cells.map((z) => z.zone));
  if (zones.length === 1) {
    const soft = ut ? `${stateName} is zoned through the "${ut}" place cell inside the ${cells[0].stateText} row` : viaSoft;
    return {
      values: zones,
      soft,
      step: { title, detail: `${via} → ${stateName} → ${zones[0]}.`, citations: cells.map((z) => zoneCite(z, `${z.place} is in ${z.zone}`)), outcome: 'ok' },
    };
  }
  // Split state: named places (BANGALORE, AHMEDABAD, ...) versus a "Rest of ..." cell.
  const loc = facts.rtoLocation.value;
  const named = loc ? cells.find((z) => !/^rest of/i.test(z.place) && placeMatches(loc, z.place)) ?? cells.find((z) => squash(z.place) === squash(loc)) : undefined;
  const rest = cells.find((z) => /^rest of/i.test(z.place));
  const hit = named ?? (loc ? rest : undefined);
  const all = cells.map((z) => zoneCite(z, `${z.place} is in ${z.zone}`));
  if (!hit) {
    return {
      values: zones,
      soft: viaSoft,
      question: {
        fact: 'rtoLocation',
        question: `${cells[0].stateText} is split between zones. Which place is the vehicle registered at?`,
        options: cells.map((z) => ({ value: z.place, label: `${z.place} (${z.zone})` })),
      },
      step: { title, detail: `${via} → ${stateName}, which the grid splits by place; the RTO location is not known, so both zones are considered.`, citations: all, outcome: 'warn' },
    };
  }
  const detail = named
    ? `${via}, RTO location "${loc}" → ${hit.place} → ${hit.zone}.`
    : `${via}, RTO location "${loc}" matches none of the named places in ${hit.stateText}, so "${hit.place}" applies → ${hit.zone}.`;
  return {
    values: [hit.zone],
    soft: named ? viaSoft : `RTO location "${loc}" placed under "${hit.place}"`,
    step: { title, detail, citations: [zoneCite(hit, `${hit.place} is in ${hit.zone}`)], outcome: 'ok' },
  };
}

function fuelDim(facts: PolicyFacts): Dimension {
  const title = 'Fuel to Petrol / Non-Petrol grid';
  const fuel = facts.fuel.value;
  const nonPetrol = footnote('nonPetrol', 'Non Petrol includes Diesel, CNG, LPG');
  const evHybrid = footnote('evHybrid', 'EV and Hybrid use the Petrol grid');
  const soft = facts.fuel.status === 'derived' ? `fuel inferred (${facts.fuel.note})` : undefined;
  if (!fuel) {
    return {
      values: ['Petrol', 'Non-Petrol'],
      question: {
        fact: 'fuel',
        question: 'What fuel does the vehicle use?',
        options: ['petrol', 'diesel', 'cng', 'lpg', 'electric', 'hybrid'].map((v) => ({ value: v, label: v })),
      },
      step: { title, detail: `Fuel not printed (${facts.fuel.note}); both Petrol and Non-Petrol columns are considered.`, citations: [nonPetrol, evHybrid], outcome: 'warn' },
    };
  }
  if (fuel === 'electric' || fuel === 'hybrid') {
    return { values: ['Petrol'], soft, step: { title, detail: `${fuel}${quote(facts.fuel)} → Petrol grid (footnote).`, citations: [evHybrid], outcome: 'ok' } };
  }
  if (fuel !== 'petrol') {
    return { values: ['Non-Petrol'], soft, step: { title, detail: `${fuel}${quote(facts.fuel)} → Non-Petrol (footnote).`, citations: [nonPetrol], outcome: 'ok' } };
  }
  const kit = facts.cngLpgKit.value;
  if (kit === true) {
    return {
      values: ['Non-Petrol'],
      soft: 'a petrol car with a CNG/LPG kit is treated as CNG/LPG',
      step: { title, detail: `Petrol with a CNG/LPG kit${quote(facts.cngLpgKit)} → Non-Petrol, as the footnote puts CNG and LPG there.`, citations: [nonPetrol], outcome: 'ok' },
    };
  }
  if (kit === null) {
    return {
      values: ['Petrol', 'Non-Petrol'],
      soft,
      question: { fact: 'cngLpgKit', question: 'Is a CNG or LPG kit fitted?', options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] },
      step: { title, detail: 'Petrol, but whether a CNG/LPG kit is fitted is unknown; a kit would move the car to Non-Petrol.', citations: [nonPetrol], outcome: 'warn' },
    };
  }
  return { values: ['Petrol'], soft, step: { title, detail: `petrol${quote(facts.fuel)}, no CNG/LPG kit → Petrol.`, outcome: 'ok' } };
}

function ncbDim(facts: PolicyFacts): Dimension {
  const title = 'NCB column';
  if (facts.businessType.value === 'new') {
    return {
      values: ['NCB'],
      soft: facts.businessType.status === 'derived' ? `new business inferred (${facts.businessType.note})` : undefined,
      step: { title, detail: `New business${quote(facts.businessType)} → NCB column (footnote).`, citations: [footnote('newBusiness', 'New Business counts as NCB')], outcome: 'ok' },
    };
  }
  const n = facts.ncbPercent.value;
  if (n === 0 && !facts.businessType.value) {
    return {
      values: ['NCB', 'N-NCB'],
      question: {
        fact: 'businessType',
        question: 'Is this a new vehicle (new business), a renewal or a rollover from another insurer?',
        options: [{ value: 'new', label: 'New business' }, { value: 'renewal', label: 'Renewal' }, { value: 'rollover', label: 'Rollover' }],
      },
      step: { title, detail: 'NCB 0% but the business type is unknown: new business counts as NCB (footnote), otherwise N-NCB.', citations: [footnote('newBusiness', 'New Business counts as NCB')], outcome: 'warn' },
    };
  }
  if (n !== null) {
    const col = n > 0 ? 'NCB' : 'N-NCB';
    return { values: [col], step: { title, detail: `NCB ${n}%${quote(facts.ncbPercent)} (${facts.businessType.value ?? 'business type unknown'}) → ${col}.`, outcome: 'ok' } };
  }
  return {
    values: ['NCB', 'N-NCB'],
    question: { fact: 'ncbPercent', question: 'What NCB percentage does this policy carry (0 if none)?' },
    step: { title, detail: `NCB on this policy not found (${facts.ncbPercent.note}); NCB and N-NCB are both considered.`, outcome: 'warn' },
  };
}

function slabDim(facts: PolicyFacts): Dimension {
  const title = 'GWP slab';
  const note = footnote('slab', 'The slab is the broker\'s comprehensive + SAOD private-car GWP, SATP excluded');
  const answer = facts.gwpSlab.value;
  const slab = typeof answer === 'string' ? grid.slabs.find((s) => squash(s) === squash(answer)) : undefined;
  if (slab) return { values: [slab], step: { title, detail: `GWP slab ${slab}, given by the user.`, citations: [note], outcome: 'ok' } };
  const own = facts.premium.netPremium.value;
  return {
    values: grid.slabs,
    question: {
      fact: SLAB_FACT,
      question: 'Which GWP slab has the broker achieved with HDFC ERGO on private car (comprehensive + SAOD premium, SATP excluded)?',
      options: grid.slabs.map((s) => ({ value: s, label: s })),
    },
    step: {
      title,
      detail: 'The footnote computes the slab on "comprehensive + SAOD GWP" for "slab achievement": an aggregate of the broker\'s private-car book, '
        + 'not a figure printed on one policy (a policy is never both comprehensive and SAOD). All five slabs stay open'
        + (own !== null ? `; this policy's own net premium (₹${own}) is not the slab basis.` : '.'),
      citations: [note],
      outcome: 'warn',
    },
  };
}

// ---------- lookup ----------

function cellFor(p: Pick): Rate {
  const cell = grid.rates.find((r) => r.zone === p.zone && r.category === p.category && r.fuel === p.fuel
    && (r.ncb === p.ncb || r.ncb === 'NCB & N-NCB') && r.slab === p.slab);
  if (!cell) throw new Error(`HDFC ERGO grid has no cell for ${JSON.stringify(p)}`);
  return cell;
}

interface Combo { pick: Pick; cell: Rate }

function enumerate(dims: Record<Dim, Dimension>): Combo[] {
  let picks: Pick[] = [{} as Pick];
  for (const d of DIMS) picks = picks.flatMap((p) => dims[d].values.map((v) => ({ ...p, [d]: v })));
  return picks.map((pick) => ({ pick, cell: cellFor(pick) }));
}

/** A dimension matters when two combinations differing only in it give different rates. */
function matters(combos: Combo[], dim: Dim): boolean {
  const seen = new Map<string, number>();
  return combos.some(({ pick, cell }) => {
    const key = DIMS.filter((d) => d !== dim).map((d) => pick[d]).join('|');
    const prev = seen.get(key);
    seen.set(key, cell.percent);
    return prev !== undefined && prev !== cell.percent;
  });
}

const DIM_LABEL: Record<Dim, string> = { zone: 'zone', category: 'category', fuel: 'fuel', ncb: 'NCB column', slab: 'GWP slab' };

function rateComponent(combos: Combo[], key: Dim[], appliesTo: string, base: number | null, context: Citation[], reason: string, forceAmbiguous = false): RateComponent {
  const rates = unique(combos.map((c) => c.cell.percent));
  const cells = (list: Combo[]) => unique(list.map((c) => c.cell)).map(rateCite);
  if (rates.length === 1 && !forceAmbiguous) {
    return component('applicable', { ratePercent: rates[0], appliesTo, premiumBase: base, reason, citations: [...context, ...cells(combos)] });
  }
  const groups = new Map<string, Combo[]>();
  for (const c of combos) {
    const k = key.map((d) => `${DIM_LABEL[d]} ${c.pick[d]}`).join(', ');
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  const candidates: RateCandidate[] = [...groups].map(([assumption, list]) => ({
    ratePercent: list[0].cell.percent,
    assumption: assumption || 'the policy is a package policy',
    citations: cells(list),
  }));
  return ambiguousComponent(appliesTo, reason, candidates, base);
}

export function resolve(facts: PolicyFacts): RateResult {
  const trace: TraceStep[] = [validity(facts)];
  const category = categoryDim(facts);
  trace.push(category.step);
  if (category.stop) {
    return buildResult({
      insurer: 'hdfc-ergo',
      grid: GRID,
      od: notApplicable(OD_BASE, 'Stand-alone TP policy: there is no own-damage premium.'),
      tp: unsupported(TP_BASE, category.stop, category.step.citations),
      confidence: { level: 'high', reason: 'The policy type is printed and the grid has no SATP category.' },
      trace,
    });
  }
  const zone = zoneDim(facts);
  trace.push(zone.step);
  if (zone.stop) {
    return buildResult({
      insurer: 'hdfc-ergo',
      grid: GRID,
      od: unsupported(OD_BASE, zone.stop, zone.step.citations),
      tp: unsupported(TP_BASE, zone.stop, zone.step.citations),
      confidence: { level: 'high', reason: 'The registration state is printed and the grid does not zone it.' },
      trace,
    });
  }
  const dims: Record<Dim, Dimension> = { zone, category, fuel: fuelDim(facts), ncb: ncbDim(facts), slab: slabDim(facts) };
  trace.push(dims.fuel.step, dims.ncb.step, dims.slab.step);

  const combos = enumerate(dims);
  const open = DIMS.filter((d) => dims[d].values.length > 1);
  const key = open.filter((d) => matters(combos, d));
  const idle = open.filter((d) => !key.includes(d));
  const context = DIMS.flatMap((d) => dims[d].step.citations ?? []);
  const rates = unique(combos.map((c) => c.cell.percent));
  trace.push({
    title: 'Look up the rate',
    detail: (rates.length === 1 ? `One rate, ${pct(rates[0])}` : `The rate depends on ${key.map((d) => DIM_LABEL[d]).join(' and ')}: ${rates.map(pct).join(' / ')}`)
      + (idle.length ? `. Unknown ${idle.map((d) => DIM_LABEL[d]).join(' and ')} does not change it - the candidate cells are equal.` : '.'),
    citations: unique(combos.map((c) => c.cell)).map(rateCite),
    outcome: rates.length === 1 ? 'ok' : 'warn',
  });

  const pkg = category.values.includes('Package');
  const categoryOpen = category.values.length > 1;
  const baseNote = pkg
    ? `The grid prints one Package rate with no OD/TP split, so it is applied to the whole package premium: OD ₹${facts.premium.netOd.value ?? '?'} and TP ₹${facts.premium.netTp.value ?? '?'} alike (GST excluded).`
    : 'SAOD rate applies to the own-damage premium.';
  trace.push({ title: 'Premium base', detail: baseNote, outcome: pkg ? 'warn' : 'ok' });

  const od = rateComponent(combos, key, OD_BASE, facts.premium.netOd.value, context, `HDFC ERGO ${category.values.join('/')} rate on the own-damage premium.`);
  const tp = !pkg
    ? notApplicable(TP_BASE, 'Stand-alone OD policy: the liability cover is with another insurer.')
    : rateComponent(
      combos.filter((c) => c.pick.category === 'Package'),
      key.filter((d) => d !== 'category'),
      TP_BASE,
      facts.premium.netTp.value,
      context,
      categoryOpen ? 'Applies only if this is a package policy (not applicable to SAOD, unsupported for SATP).' : 'Package rate applied to the liability premium of the package.',
      categoryOpen,
    );

  const questions = DIMS.filter((d) => dims[d].question && (key.includes(d) || d === 'category')).map((d) => dims[d].question!);
  const soft = [...DIMS.map((d) => dims[d].soft), pkg ? 'the single Package rate is applied to both OD and TP' : undefined].filter((s): s is string => !!s);
  const level = soft.length === 0 ? 'high' : soft.length === 1 ? 'medium' : 'low';
  const needs = questions.length ? `Needs: ${questions.map((q) => q.fact).join(', ')}. ` : '';
  return buildResult({
    insurer: 'hdfc-ergo',
    grid: GRID,
    od,
    tp,
    confidence: { level, reason: `${needs}${soft.length ? `Interpretation: ${soft.join('; ')}.` : 'Every decisive fact was printed and read cleanly.'}` },
    trace,
    questions,
  });
}
