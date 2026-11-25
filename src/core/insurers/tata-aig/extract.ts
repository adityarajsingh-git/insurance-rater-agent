// Tata AIG "Auto Secure" policy extraction and detection. Built for tesseract OCR as the browser
// produces it: each fact is read from every page that prints it (welcome page, certificate,
// premium schedule, proposal transcript, receipt) and agreeing hits all become evidence.
import {
  derived,
  emptyFacts,
  evidenceOf,
  findAll,
  found,
  missing,
  moneyAll,
  normaliseFuel,
  parseAllDates,
  parseDate,
  yearsBetween,
  type LineHit,
} from '../../extract/common';
import { normaliseRtoCode, stateCodeFromName, stateFromCode } from '../../geo';
import type { Evidence, Fact, PageText, PolicyFacts, PolicyType } from '../../types';
import type { Detection } from '../module';

const PREVIOUS_START = /Previous Insurance Details/i;
const PREVIOUS_END = /Nominee Details|Restriction of Cover/i;

/** Splits the proposal transcript's previous-policy block off, so it never feeds current-policy facts. */
function splitPrevious(pages: PageText[]): { current: PageText[]; previous: PageText[] } {
  const current: PageText[] = [];
  const previous: PageText[] = [];
  for (const p of pages) {
    const lines = p.text.split(/\r?\n/);
    const start = lines.findIndex((l) => PREVIOUS_START.test(l));
    if (start < 0) {
      current.push(p);
      continue;
    }
    const after = lines.slice(start).findIndex((l) => PREVIOUS_END.test(l));
    const end = after < 0 ? lines.length : start + after;
    current.push({ ...p, text: [...lines.slice(0, start), ...lines.slice(end)].join('\n') });
    previous.push({ ...p, text: lines.slice(start, end).join('\n') });
  }
  return { current, previous };
}

const rest = (h: LineHit) => h.line.slice((h.match.index ?? 0) + h.match[0].length);

/** First hit's value wins; hits that parse to the same value add evidence (one per page, at most three). */
function agreeing<T>(hits: LineHit[], parse: (h: LineHit) => T | null | undefined): Fact<T> | null {
  const parsed = hits.flatMap((h) => {
    const v = parse(h);
    return v === null || v === undefined ? [] : [{ h, v }];
  });
  if (!parsed.length) return null;
  const v = parsed[0].v;
  const pages = [...new Map(parsed.filter((x) => x.v === v).map((x) => [x.h.page, x.h])).values()];
  return found(v, pages.slice(0, 3).map((h) => evidenceOf(h)));
}

/** Rupee amount printed after a label: the last number on the line, which skips OCR junk such as "3? 2094". */
const amountAfter = (pages: PageText[], label: RegExp) => agreeing(findAll(pages, label), (h) => moneyAll(rest(h)).at(-1));

const textAfter = (pages: PageText[], re: RegExp) => agreeing(findAll(pages, re), (h) => h.match[1]?.trim() || null);

const ev = (...facts: Fact<unknown>[]): Evidence[] => facts.flatMap((f) => f.evidence);

const SIGNALS: [RegExp, number][] = [
  [/U85110MH2000PLC128425/, 0.5], // Tata AIG CIN
  [/TATA\s*AIG\s+GENERAL\s+INSURANCE\s+COMPANY\s+LIMITED/i, 0.3],
  [/IRDAN108/i, 0.2], // Tata AIG product UIN prefix
  [/tataaig\.com|taig\.in/i, 0.2],
];

export function detect(pages: PageText[]): Detection | null {
  const { current } = splitPrevious(pages);
  let score = 0;
  const evidence: Evidence[] = [];
  for (const [re, weight] of SIGNALS) {
    // A "previous insurer: Tata AIG" line on another insurer's policy must not count.
    const hit = findAll(current, re).find((h) => !/previous/i.test(h.line));
    if (!hit) continue;
    score += weight;
    evidence.push(evidenceOf(hit));
  }
  return score ? { insurer: 'tata-aig', score: Math.min(1, score), evidence } : null;
}

function policyType(pages: PageText[]): Fact<PolicyType> {
  const classify = (s: string): PolicyType | null =>
    /liability only|third[\s-]*party only|stand[\s-]*alone\s*tp/i.test(s) ? 'satp'
      : /own damage|\bsaod\b|stand[\s-]*alone\s*od/i.test(s) ? 'saod'
        : /package|comprehensive|private car/i.test(s) ? 'package'
          : null;
  const product = agreeing(findAll(pages, /Auto Secure\s*-\s*(.+?Policy)/i), (h) => classify(h.match[1]));
  const liability = findAll(pages, /Section\s*-\s*\S+\s*Liability to Third[\s-]*Part/i)[0];
  const ownDamage = findAll(pages, /Section\s*-\s*\S+\s*Own Damage|Own Damage Premium/i)[0];
  if (product) {
    const schedule = product.value === 'satp' && liability && !ownDamage ? [evidenceOf(liability)] : [];
    return { ...product, evidence: [...product.evidence, ...schedule] };
  }
  if (liability && ownDamage) return derived('package', [evidenceOf(liability), evidenceOf(ownDamage)], 'Schedule has both an OD and a liability section');
  if (liability) return derived('satp', [evidenceOf(liability)], 'Schedule has a liability section and no own-damage section');
  if (ownDamage) return derived('saod', [evidenceOf(ownDamage)], 'Schedule has an own-damage section and no liability section');
  return missing('No product name or premium-schedule section found');
}

function premium(current: PageText[], type: PolicyType | null): PolicyFacts['premium'] {
  const total = amountAfter(current, /Total Policy Premium|Premium Amount \(Including GST\)/i);
  const gst = amountAfter(current, /\bIGST\s*@?\s*\d+(?:\.\d+)?\s*%/i);
  const printedNet = amountAfter(current, /Net Premium\s*\(B\)/i);
  let netPremium: Fact<number> = printedNet ?? missing('Net Premium (B) not legible');
  if (!printedNet && total?.value != null && gst?.value != null) {
    const v = Math.round((total.value - gst.value) * 100) / 100;
    netPremium = derived(v, ev(total, gst), `Net Premium (B) is not legible; derived as total premium ${total.value} - GST ${gst.value}`);
  }
  let netTp: Fact<number> = amountAfter(current, /Total Liability Premium(?:\s*\(A\))?/i) ?? missing('Total Liability Premium (A) not legible');
  if (netTp.status === 'missing' && type === 'satp' && netPremium.value !== null) {
    netTp = derived(netPremium.value, netPremium.evidence, 'Liability-only policy: the schedule has only the liability section, so its total equals the net premium');
  }
  const netOd: Fact<number> = type === 'satp'
    ? missing('Liability-only policy: the schedule has no own-damage section')
    : amountAfter(current, /(?:Total|Net) Own Damage Premium(?:\s*\([A-Z]\))?/i) ?? missing('Own-damage premium not legible');
  return {
    netOd,
    netTp,
    netPremium,
    gst: gst ?? missing('GST line not legible'),
    total: total ?? missing('Total premium not legible'),
  };
}

export function extract(pages: PageText[]): PolicyFacts {
  const facts = emptyFacts();
  const { current, previous } = splitPrevious(pages);

  const cin = findAll(current, /U85110MH2000PLC128425/)[0];
  const name = findAll(current, /TATA\s*AIG\s+GENERAL\s+INSURANCE\s+COMPANY\s+LIMITED/i)[0];
  if (name) facts.insurerName = found('TATA AIG General Insurance Company Limited', name);
  if (cin || name) facts.insurer = found('tata-aig', [cin, name].filter((h): h is LineHit => !!h).map((h) => evidenceOf(h)));

  facts.policyType = policyType(current);

  // Vehicle: the transcript's "Vehicle Details: MAKE / MODEL / VARIANT / BODY", else the certificate's Make / Model row.
  const details = findAll(current, /Vehicle Details\s*:\s*(.+)/i)[0];
  const makeModel = findAll(current, /Make\s*\/\s*Model\s*\/\s*\|?\s*([A-Z][A-Z0-9 .&-]*?)\s*\/\s*([A-Z0-9][A-Z0-9 .&-]*?)\s*\/?\s*(?:\||Mfg|$)/i)[0];
  const parts = details ? details.match[1].split('/').map((s) => s.trim()) : makeModel ? [makeModel.match[1], makeModel.match[2]] : [];
  const vehicleHit = details ?? makeModel;
  if (vehicleHit && parts[0]) facts.make = found(parts[0], vehicleHit);
  if (vehicleHit && parts[1]) facts.model = found(parts[1], vehicleHit, parts[2] ? `Variant ${parts[2]}` : undefined);

  const fuelFact = agreeing(findAll(current, /Fuel Type\s*[:|]?\s*([A-Za-z][A-Za-z +/]*)/i), (h) => normaliseFuel(h.match[1]));
  const variant = findAll(current, /Variant\s*\|?\s*(.+)/i)[0];
  const variantFuel = variant ? normaliseFuel(variant.match[1]) : null;
  if (fuelFact) facts.fuel = fuelFact;
  else if (variant && variantFuel) facts.fuel = derived(variantFuel, [evidenceOf(variant)], 'Fuel Type not legible; taken from the variant name');

  const kit = findAll(current, /CNG\s*\/\s*LPG\s*k\w*\s*TP|\bIMT\s*25\b/i);
  facts.cngLpgKit = kit.length
    ? found(true, kit.map((h) => evidenceOf(h)), 'CNG/LPG kit TP line (IMT 25) on the policy')
    : missing('No CNG/LPG kit TP line or IMT 25 endorsement found');

  const num = (re: RegExp) => agreeing(findAll(current, re), (h) => Number(h.match[1]));
  facts.cc = num(/CC\s*\/\s*KW\s*\|?\s*(\d{2,4})\b/i) ?? missing('CC/KW not legible');
  facts.seats = num(/Seating Capacity\s*\|?\s*(\d{1,2})\b/i) ?? missing('Seating capacity not legible');
  facts.manufactureYear = num(/Mfg\.?\s*Year\s*\|?\s*((?:19|20)\d{2})\b/i) ?? missing('Manufacture year not legible');
  facts.registrationDate = agreeing(findAll(current, /Date of Registration\s*[:|]?\s*(.+)/i), (h) => parseDate(h.match[1]))
    ?? missing('Registration date not legible');

  // Period: prefer the TP cover line (LTTP is about TP tenure); the welcome page and transcript both print it.
  const periods = findAll(current, /Cover(?: Period)?\b.*\d{2}\/\d{2}\/\d{4}.*\d{2}\/\d{2}\/\d{4}/i)
    .sort((a, b) => Number(/third[\s-]*party|\bTP\b/i.test(b.line)) - Number(/third[\s-]*party|\bTP\b/i.test(a.line)));
  const startFact = agreeing(periods, (h) => parseAllDates(h.line)[0]);
  const endFact = agreeing(periods, (h) => parseAllDates(h.line)[1]);
  facts.policyStart = startFact ?? missing('Cover period not legible');
  facts.policyEnd = endFact ?? missing('Cover period not legible');

  const reg = facts.registrationDate.value;
  const start = facts.policyStart.value;
  if (reg && start) {
    facts.vehicleAgeYears = derived(yearsBetween(reg, start), ev(facts.registrationDate, facts.policyStart),
      `Completed years from registration ${reg} to policy start ${start}`);
  }

  // Registration mark and RTO. Delhi marks carry a class letter ("DL 9C") that is not part of the RTO code.
  const regHit = findAll(current, /Registration No\.?\s*\|?\s*([A-Z]{2}[\s-]*\d{1,2}[A-Z]?[\s-]*[A-Z]{0,3}[\s-]*\d{1,4})\b/)[0];
  if (regHit) {
    facts.registrationNumber = found(regHit.match[1].replace(/\s+/g, ' '), regHit);
    const m = regHit.match[1].match(/^([A-Z]{2})[\s-]*(\d{1,2}[A-Z]?)/);
    const code = m ? normaliseRtoCode(`${m[1]}${m[2]}`) : null;
    if (code) facts.rtoCode = derived(code, [evidenceOf(regHit)], `RTO code read from registration mark ${regHit.match[1]}`);
  } else {
    facts.registrationNumber = missing('Registration number not legible in the page text');
    facts.rtoCode = missing('Registration number not legible, so no RTO code; RTO Location is used instead');
  }
  const rto = textAfter(current, /RTO Location\s*\|?\s*([A-Za-z][A-Za-z .&()-]*?)\s*(?:\||No\.? of|$)/i);
  if (rto) facts.rtoLocation = rto;
  const stateCode = facts.rtoCode.value?.slice(0, 2) ?? (rto?.value ? stateCodeFromName(rto.value) : null);
  const stateName = stateCode ? stateFromCode(stateCode) : null;
  if (stateName) {
    facts.state = derived(stateName, facts.rtoCode.value ? facts.rtoCode.evidence : ev(facts.rtoLocation),
      facts.rtoCode.value ? `State of RTO code ${facts.rtoCode.value}` : `State named by RTO Location ${rto?.value}`);
  }

  facts.ncbPercent = missing(facts.policyType.value === 'satp'
    ? 'Liability-only policy: NCB applies to OD premium only and none is printed'
    : 'No current-policy NCB % printed');

  // Previous policy -> business type (challenge rule: same insurer = renewal, different = rollover).
  const prevName = textAfter(previous, /Name of the Insurer\s*:\s*(.+)/i);
  const hasPrevious = prevName?.value && !/^(NA|N\/A|-)$/i.test(prevName.value);
  if (prevName && hasPrevious) {
    facts.previousInsurer = prevName;
    const expiry = agreeing(findAll(previous, /Date of Expiry\s*:\s*(.+)/i), (h) => parseDate(h.match[1]));
    const gap = expiry?.value && start ? (Date.parse(start) - Date.parse(expiry.value)) / 86_400_000 : 0;
    const breakIn = gap > 1 && expiry ? ` Previous policy expired ${expiry.value}, ${gap} days before this cover starts (break-in).` : '';
    const same = /tata\s*-?\s*aig/i.test(prevName.value!);
    facts.businessType = derived(same ? 'renewal' : 'rollover', [...prevName.evidence, ...(expiry?.evidence ?? [])],
      `Previous insurer ${prevName.value} is ${same ? 'Tata AIG, the current insurer: renewal' : 'another insurer: rollover'}.${breakIn}`);
  } else if (reg && start && (Date.parse(start) - Date.parse(reg)) / 86_400_000 <= 60) {
    facts.businessType = derived('new', ev(facts.registrationDate, facts.policyStart), 'No previous policy and registered within 60 days of the policy start');
  } else {
    facts.businessType = missing('No previous-insurer details found');
  }

  facts.premium = premium(current, facts.policyType.value);
  return facts;
}
