// Reliance General (IndusInd) motor policy reader. The schedule (p2), risk assumption letter (p5),
// proposal form (p9-p13) repeat most facts, so each fact tries every page that carries it. Works on
// both the text layer and OCR; Vision OCR separates table cells with "|", tesseract does not.
import {
  derived,
  emptyFacts,
  evidenceOf,
  findAll,
  findFirst,
  found,
  lines,
  missing,
  moneyAll,
  parseDate,
  yearsBetween,
  ambiguous,
  normaliseFuel,
  type LineHit,
} from '../../extract/common';
import { parseRegistration, stateCodeFromName, stateFromCode } from '../../geo';
import type { Evidence, Fact, PageText, PolicyFacts, PolicyType } from '../../types';
import type { Detection } from '../module';

/** Opted covers (PolicyFacts.covers) feed PC!H4 / PC!H6 (add-on modifiers) and ENB!A47 (CPA). */
export type RelianceFacts = PolicyFacts;

const INSURER_RE = /(?:Reliance|IndusInd) General Insurance Co(?:mpany|\.)?\s*(?:Limited|Ltd)?/i;

const MARKERS: RegExp[] = [
  INSURER_RE,
  /reli?ance\s?general\.co\.in/i,
  /IRDAI Registration No\.?\s*103\b/i,
  /Reliance Private Car|RGI\/MCOM/i,
];

/** A bare name mention (e.g. as a previous insurer) scores 0.25; the insurer's own branding scores higher. */
export function detect(pages: PageText[]): Detection | null {
  const hits = MARKERS.map((re) => findFirst(pages, re)).filter((h): h is LineHit => h !== null);
  if (!hits.length) return null;
  return { insurer: 'reliance', score: [0, 0.25, 0.5, 0.75, 0.95][hits.length], evidence: hits.map((h) => evidenceOf(h)) };
}

/** Last money-looking number on the line after the label (labels like "(Sec I + II + III)" hold digits). */
function lastMoney(hit: LineHit | null): number | null {
  if (!hit) return null;
  const all = moneyAll(hit.match[1] ?? '');
  return all.length ? all[all.length - 1] : null;
}

function money(pages: PageText[], label: string, note?: string): Fact<number> {
  const hit = findFirst(pages, new RegExp(`${label}\\b(.*)$`, 'i'));
  const v = lastMoney(hit);
  return hit && v !== null ? found(v, hit, note) : missing(`No "${label}" amount found`);
}

/** Every hit's capture, mapped; one value -> found with all evidence, several -> ambiguous. */
function agreed<T>(hits: LineHit[], map: (h: LineHit) => T | null, note?: string): Fact<T> | null {
  const pairs = hits.map((h) => [h, map(h)] as const).filter((p): p is readonly [LineHit, T] => p[1] !== null);
  if (!pairs.length) return null;
  const values = [...new Set(pairs.map(([, v]) => v))];
  const evidence = pairs.slice(0, 3).map(([h]) => evidenceOf(h));
  return values.length === 1 ? found(values[0], evidence, note) : ambiguous(values, evidence, 'The pages disagree');
}

function policyTypeOf(s: string): PolicyType | null {
  if (/package|comprehensive|own damage \+ third party/i.test(s)) return 'package';
  if (/liability only|third party only|act only/i.test(s)) return 'satp';
  if (/stand\s*-?\s*alone|own damage only|\bSAOD\b/i.test(s)) return 'saod';
  return null;
}

/** Models sold in India with petrol engines only. ponytail: one row; add models as Reliance samples need them. */
const PETROL_ONLY = [/^RENAULT KWID\b/i];

function fuelFact(pages: PageText[], makeModel: LineHit | null, kitHit: LineHit | null, kit: number | null): PolicyFacts['fuel'] {
  const printed = findFirst(pages, /\bFuel\s*Type[\s|:]*(Petrol|Diesel|CNG|LPG|Electric|Battery|Hybrid)\b/i);
  const fuel = printed && normaliseFuel(printed.match[1]);
  if (printed && fuel) return found(fuel, printed);
  const evidence = [makeModel, kitHit].filter((h): h is LineHit => h !== null).map((h) => evidenceOf(h));
  if (kit !== null && kit > 0) {
    return ambiguous(['cng', 'lpg'], evidence, `Fuel is not printed; a CNG / LPG kit with IDV ${kit} is declared, so the car is bi-fuel (CNG or LPG).`);
  }
  if (makeModel && kit === 0 && PETROL_ONLY.some((re) => re.test(makeModel.match[1]))) {
    return derived('petrol', evidence,
      `Fuel is not printed on the policy. Derived: ${makeModel.match[1].trim()} has no diesel or EV variant in India, and the CNG / LPG kit IDV is 0.00, so no bi-fuel kit is declared.`);
  }
  return missing('Fuel type is not printed on the policy and cannot be derived from the make/model.', evidence);
}

/** Opted add-ons from the schedule's "Add on Cover/s Opted" list, plus CPA and the proposal's Tyre / RTI answers. */
function coversFact(pages: PageText[]): Fact<string[]> {
  const head = findFirst(pages, /Add on Cover\/?s? Opted/i);
  if (!head) return missing('No "Add on Cover/s Opted" list found');
  const page = pages.find((p) => p.page === head.page)!;
  const pageLines = lines(page);
  const names: string[] = [];
  const evidence: Evidence[] = [evidenceOf(head)];
  for (const line of pageLines.slice(pageLines.findIndex((l) => head.line === l) + 1)) {
    if (/TOTAL OWN DAMAGE PREMIUM/i.test(line)) break;
    const name = line.split('|')[0].replace(/\b(?:TOTAL|IGST|CGST|SGST|UTGST)\b.*$/i, '').trim();
    if (/[a-z]{3}/i.test(name)) {
      names.push(name);
      evidence.push({ page: head.page, quote: line, source: head.source });
    }
  }
  const cpa = findFirst(pages, /Compulsory PA cover to Owner Driver[\s|:]*([\d,]+\.\d{2})/i);
  if (cpa && (lastMoney(cpa) ?? 0) > 0) {
    names.push('Compulsory PA cover to Owner Driver');
    evidence.push(evidenceOf(cpa));
  }
  for (const h of findAll(pages, /(Tyre Protector|Return to Invoice)\b.*\b(Yes|No)$/i)) {
    evidence.push(evidenceOf(h));
    if (/yes/i.test(h.match[2]) && !names.some((n) => n.toLowerCase().includes(h.match[1].toLowerCase()))) names.push(h.match[1]);
  }
  return found(names, evidence, 'Add-ons listed under "Add on Cover/s Opted", plus CPA when charged; Tyre Protector / Return to Invoice answers from the proposal form.');
}

export function extract(pages: PageText[]): RelianceFacts {
  const f: RelianceFacts = emptyFacts();

  const ins = findFirst(pages, INSURER_RE);
  if (ins) {
    f.insurerName = found(ins.match[0].trim(), ins);
    f.insurer = found('reliance', ins);
  }

  const typeHits = [
    ...findAll(pages, /Private Car (.+?) Policy\s*-\s*(?:Schedule|Proposal Form)/i),
    ...findAll(pages, /(Vehicle Own Damage \+ Third Party|Third Party Only|Liability Only) Cover(?:age)?\s*$/i),
  ];
  f.policyType = agreed(typeHits, (h) => policyTypeOf(h.match[1])) ?? missing('No policy title or cover line found');

  const prev = findFirst(pages, /Full Name of previous insurer[\s|:]*([A-Za-z][A-Za-z .&]*[A-Za-z])/i);
  const prevExpiry = findFirst(pages, /Previous Policy Expiry[\s|:]*(\d{1,2}-[A-Za-z]{3}-\d{2,4})/i);
  if (prev) {
    f.previousInsurer = found(prev.match[1].trim(), prev);
    const same = /reliance|indusind/i.test(prev.match[1]);
    const evidence = [prev, prevExpiry].filter((h): h is LineHit => h !== null).map((h) => evidenceOf(h));
    f.businessType = same
      ? derived('renewal', evidence, 'The previous insurer is Reliance General, the same insurer as this policy, so it is a renewal.')
      : derived('rollover', evidence, `The previous insurer (${prev.match[1].trim()}) differs from Reliance General, so it is a rollover.`);
  } else {
    f.previousInsurer = missing('No previous-insurer details found');
    f.businessType = missing('No previous-insurance details found, and OCR cannot read the proposal form\'s "A new Policy / Renewal" tick boxes.');
  }

  const mm = findFirst(pages, /Make\s*\/\s*Model\s*&\s*Variant[\s|:]*([A-Z][A-Z0-9 .\-]*?)(?=\s*\|?\s*(?:CC\b|Date of Registration|$))/i);
  if (mm) {
    const [make, ...model] = mm.match[1].trim().split(/\s+/);
    f.make = found(make.toUpperCase(), mm);
    if (model.length) f.model = found(model.join(' '), mm);
  } else {
    const make = findFirst(pages, /Make of Vehicle[\s|:]*([A-Z][A-Z &-]*[A-Z])/i);
    if (make) f.make = found(make.match[1], make);
  }

  const kitHit = findFirst(pages, /CNG\s*\/\s*LPG Kit\b(.*)$/i);
  const kit = lastMoney(kitHit);
  if (kitHit && kit !== null) {
    f.cngLpgKit = derived(kit > 0, [evidenceOf(kitHit)], `CNG / LPG kit IDV is ${kit.toFixed(2)}${kit > 0 ? '' : ', so no kit is declared'}.`);
  }
  f.fuel = fuelFact(pages, mm, kitHit, kit);

  f.cc = agreed(findAll(pages, /(?:\bCC\s*\/\s*HP(?:\s*\/\s*Wat)?|Cubic Capacity)[\s|:]*(\d{2,5})\b/i), (h) => Number(h.match[1]))
    ?? missing('No cubic capacity found');

  const seats = findFirst(pages, /Seating Capacity Including Driv\w*[\s|:]*(\d{1,2})\b/i);
  if (seats) f.seats = found(Number(seats.match[1]), seats);

  const mfg = findFirst(pages, /(?:Mfg\.? Month & Year|Year & Month of Manufacture)[\s|:]*[A-Z]{3}[\s-]*(\d{4})/i);
  if (mfg) f.manufactureYear = found(Number(mfg.match[1]), mfg);

  const regDate = findFirst(pages, /Date of Registration[\s|:]*(\d{1,2}[-\s][A-Za-z]{3}[-\s]\d{4})/i);
  const regIso = regDate && parseDate(regDate.match[1]);
  if (regDate && regIso) f.registrationDate = found(regIso, regDate);

  const period = findFirst(pages, /From 00:00 Hrs on (\S+) to Midnight of (\S+)/i);
  const start = period && parseDate(period.match[1]);
  const end = period && parseDate(period.match[2]);
  if (period && start) f.policyStart = found(start, period);
  if (period && end) f.policyEnd = found(end, period);

  if (regDate && regIso && period && start) {
    f.vehicleAgeYears = derived(yearsBetween(regIso, start), [evidenceOf(regDate), evidenceOf(period)],
      `Whole years from registration (${regIso}) to policy start (${start}).`);
  }

  const reg = findFirst(pages, /Registration (?:No\.?|Number)[\s|:_]*([A-Z]{2}[\s-]*\d{1,2}[\s-]*[A-Z]{0,3}[\s-]*\d{1,4})\b/i);
  const mark = reg && parseRegistration(reg.match[1]);
  if (reg && mark) {
    f.registrationNumber = found(mark.normalised.replace(/-/g, ''), reg);
    f.rtoCode = found(mark.rtoCode, reg, 'State and district part of the registration mark.');
  } else {
    f.registrationNumber = missing('No registration number found');
    f.rtoCode = missing('No registration number found');
  }

  const loc = findFirst(pages, /(?:RTO Location|Registering Authority & Location)[\s|:]*([A-Za-z][A-Za-z .]*?\s*-\s*[A-Za-z][A-Za-z .]*?)(?=\s*(?:\||Total Premium|LCC|$))/i);
  if (loc) {
    f.rtoLocation = found(loc.match[1].trim(), loc);
    const code = stateCodeFromName(loc.match[1].split('-')[0]);
    if (code) f.state = found(stateFromCode(code)!, loc);
  } else if (reg && mark) {
    f.state = derived(stateFromCode(mark.stateCode)!, [evidenceOf(reg)], 'State code of the registration mark.');
  }

  const ncb = findFirst(pages, /Deduct\s*(\d{1,2})\s*%\s*for NCB/i);
  if (ncb) f.ncbPercent = found(Number(ncb.match[1]), ncb);

  f.premium.netOd = money(pages, 'TOTAL OWN DAMAGE PREMIUM');
  f.premium.netTp = money(pages, 'Total Basic Liability Premium',
    'Basic TP (Section II). TOTAL LIABILITY PREMIUM also adds the owner-driver PA cover and legal liability to the paid driver, which are not TP premium.');
  f.premium.netPremium = money(pages, 'TOTAL PACKAGE PREMIUM');
  f.premium.total = money(pages, 'TOTAL PREMIUM PAYABLE');
  const gst = findAll(pages, /\b(?:IGST|CGST|SGST|UTGST)\s*\(@?\s*[\d.]+\s*%\)(.*)$/i);
  const gstSum = gst.reduce((sum, h) => sum + (lastMoney(h) ?? 0), 0);
  f.premium.gst = gst.length ? found(Math.round(gstSum * 100) / 100, gst.map((h) => evidenceOf(h))) : missing('No GST line found');

  f.covers = coversFact(pages);
  return f;
}
