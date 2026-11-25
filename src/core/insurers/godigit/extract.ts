// Go Digit policy schedule -> PolicyFacts. Built against the tesseract text of the sample
// (values often missing from table cells, rupee sign misread) and the cleaner Vision OCR,
// so every fact has a fallback where the document offers one.
import type { Evidence, Fact, PageText, PolicyFacts, PolicyType } from '../../types';
import {
  ambiguous,
  derived,
  emptyFacts,
  evidenceOf,
  findAll,
  findFirst,
  flat,
  found,
  lines,
  missing,
  normaliseFuel,
  parseDate,
  parseMoney,
  yearsBetween,
} from '../../extract/common';
import { parseRegistration, squash, STATE_BY_CODE } from '../../geo';
import type { Detection } from '../module';

const NAME_RE = /go\s*digit\s+general\s+insurance/i;
const DATE = String.raw`(\d{1,2}[-/ ][A-Za-z]{3,9}[-/ ]\d{4}|\d{1,2}[-/.]\d{1,2}[-/.]\d{4})`;
const REG_SCAN = /\b([A-Z]{2})[ -]?(\d{1,2})[ -]?([A-Z]{1,3})[ -]?(\d{4})\b/g;

export function detect(pages: PageText[]): Detection | null {
  const signals: [RegExp, number][] = [[NAME_RE, 0.6], [/godigit\.com/i, 0.2], [/IRDAN158/i, 0.2]];
  const evidence: Evidence[] = [];
  let score = 0;
  for (const [re, weight] of signals) {
    // A "Previous Insurer: Go Digit" line on another insurer's policy is not a sign of Go Digit.
    const hit = findAll(pages, re).find((h) => !/previous/i.test(h.line));
    if (!hit) continue;
    score += weight;
    evidence.push(evidenceOf(hit));
  }
  return score ? { insurer: 'godigit', score: Math.round(score * 100) / 100, evidence } : null;
}

/** First matching line whose capture parses; the fact quotes that line. */
function pick<T>(pages: PageText[], re: RegExp, parse: (m: RegExpMatchArray) => T | null, note?: string): Fact<T> | null {
  for (const hit of findAll(pages, re)) {
    const value = parse(hit.match);
    if (value !== null) return found(value, hit, note);
  }
  return null;
}

/** Same as pick, over whole-page text, for values OCR puts on the line after their label. */
function pickFlat<T>(pages: PageText[], re: RegExp, parse: (m: RegExpMatchArray) => T | null): Fact<T> | null {
  for (const p of pages) {
    const m = flat(p).match(re);
    const value = m ? parse(m) : null;
    if (m && value !== null) return found(value, [{ page: p.page, quote: m[0].trim(), source: p.source }]);
  }
  return null;
}

const money = (s: string) => parseMoney(s.match(/\d[\d,]*\.\d{2}/)?.[0]);
const clean = (s: string) => s.replace(/\s*\|\s*/g, ' ').replace(/\s*,\s*/g, ', ').trim();

function policyType(pages: PageText[]): Fact<PolicyType> {
  const title = findFirst(pages, /(private car|two wheeler|commercial|goods|passenger|taxi|liability only|package|comprehensive|bundled|own damage).*\bpolicy\b/i);
  if (title) {
    const t = title.line;
    if (!/private car|\bcar\b/i.test(t) && /two wheeler|bike|commercial|goods|passenger carrying|taxi|\bbus\b/i.test(t)) {
      return missing(`"${t.slice(0, 80)}" is not a private-car policy; the Go Digit private-car sheets do not apply`, [evidenceOf(title)]);
    }
    if (/liability only|third party only|stand[- ]?alone (tp|third party)/i.test(t)) return found('satp', title);
    if (/stand[- ]?alone own damage|own damage only|\bsaod\b/i.test(t)) return found('saod', title);
    if (/package|comprehensive|bundled/i.test(t)) return found('package', title);
  }
  const liability = findFirst(pages, /LIABILITY PREMIUM/i);
  if (liability && !findFirst(pages, /own damage premium|\bOD premium/i)) {
    return derived('satp', [evidenceOf(liability)], 'The only premium section is LIABILITY PREMIUM and there is no own-damage premium, so stand-alone TP');
  }
  return missing('No policy-type title found');
}

function registration(pages: PageText[]): Fact<string> {
  const labelled = pick(pages, /Registration No\.?\s*[:|]?\s*([A-Z]{2}[ -]?\d{1,2}[ -]?[A-Z]{1,3}[ -]?\d{4})\b/i, (m) => {
    const v = m[1].toUpperCase().replace(/[ -]/g, '');
    return parseRegistration(v) ? v : null;
  });
  if (labelled) return labelled;
  // The labelled cell is often blank in tesseract output; the mark is repeated beside the insured's name.
  const tally = new Map<string, Evidence[]>();
  for (const p of pages) {
    for (const line of lines(p)) {
      for (const m of line.toUpperCase().matchAll(REG_SCAN)) {
        if (!STATE_BY_CODE[m[1]]) continue;
        const v = m[0].replace(/[ -]/g, '');
        tally.set(v, [...(tally.get(v) ?? []), { page: p.page, quote: line, source: p.source }]);
      }
    }
  }
  const ranked = [...tally].sort((a, b) => b[1].length - a[1].length);
  if (!ranked.length) return missing('No registration number found');
  if (ranked.length > 1 && ranked[0][1].length === ranked[1][1].length) {
    return ambiguous(ranked.map(([v]) => v), ranked.flatMap(([, e]) => e).slice(0, 4), 'Several different registration numbers are printed');
  }
  return found(ranked[0][0], ranked[0][1].slice(0, 3), 'The labelled field is blank in this text; read from the line that repeats the insured name and registration number');
}

function stateIn(text: string): string | null {
  const t = squash(text);
  const names = [...new Set(Object.values(STATE_BY_CODE))].sort((a, b) => b.length - a.length);
  return names.find((n) => t.includes(squash(n))) ?? null;
}

function previousInsurer(f: PolicyFacts, pages: PageText[]): void {
  const hit = findFirst(pages, /Previous Insurer(?: Name)?\b\s*[:|]?\s*(.*)$/i);
  if (!hit) return;
  const name = clean(hit.match[1]);
  if (/^(-+|na|n\/a|nil|none)$/i.test(name)) {
    f.previousInsurer = missing('No previous insurer (field printed as a dash or NA)', [evidenceOf(hit)]);
    f.businessType = derived('new', [evidenceOf(hit)], 'No previous insurer is printed, so new business');
    return;
  }
  if (!name) return;
  f.previousInsurer = found(name, hit);
  f.businessType = /go\s*digit/i.test(name)
    ? derived('renewal', [evidenceOf(hit)], 'The previous insurer is Go Digit, the same as the current insurer, so renewal (challenge rule)')
    : derived('rollover', [evidenceOf(hit)], `The previous insurer (${name}) differs from Go Digit, so rollover`);
}

function vehicleDates(f: PolicyFacts, pages: PageText[]): void {
  const start = f.policyStart.value;
  const startYear = start ? Number(start.slice(0, 4)) : 2100;
  const mfg = findFirst(pages, /Year of Mfg\.?\s*[:|]?\s*(\d[\d/-]{3,9})/i);
  if (mfg) {
    const year = Number(mfg.match[1].slice(0, 4));
    f.manufactureYear = year >= 1950 && year <= startYear
      ? found(year, mfg)
      : missing(`Year of Mfg. prints "${mfg.match[1]}", a placeholder rather than a year`, [evidenceOf(mfg)]);
  }
  const regDate = pick(pages, /(?:Date of Regist(?:ration|n)|Regist(?:ration|n)\.? Date)\s*[:|]?\s*(.{6,20})/i, (m) => parseDate(m[1]));
  const regYear = findFirst(pages, /Year of Regn\.?\s*[:|]?\s*(\d{4})\b/i);
  if (regDate) f.registrationDate = regDate;
  else if (regYear) f.registrationDate = missing(`Only the registration year (${regYear.match[1]}) is printed`, [evidenceOf(regYear)]);

  if (!start) {
    f.vehicleAgeYears = missing('Policy start date not found, so the age at start cannot be computed');
  } else if (f.registrationDate.value) {
    f.vehicleAgeYears = derived(yearsBetween(f.registrationDate.value, start), [...f.registrationDate.evidence, ...f.policyStart.evidence],
      `Whole years from registration ${f.registrationDate.value} to policy start ${start}`);
  } else {
    const basis = regYear ? { year: Number(regYear.match[1]), what: 'registration', ev: evidenceOf(regYear) }
      : f.manufactureYear.value !== null ? { year: f.manufactureYear.value, what: 'manufacture', ev: f.manufactureYear.evidence[0] } : null;
    if (!basis) {
      f.vehicleAgeYears = missing('Neither a registration date nor a manufacture year is printed');
    } else {
      const hi = startYear - basis.year;
      f.vehicleAgeYears = ambiguous([hi - 1, hi].filter((n) => n >= 0), [basis.ev, ...f.policyStart.evidence],
        `Only the ${basis.what} year ${basis.year} is printed: at the ${start} start the vehicle is ${hi - 1} or ${hi} whole years old, depending on the month`);
    }
  }
}

function premium(f: PolicyFacts, pages: PageText[]): void {
  const p = f.premium;
  p.netTp = pick(pages, /Basic Third[- ]?Party Liability\b(.*)$/i, (m) => money(m[1]),
    'Basic TP (the "Basic Third-Party Liability" line), the base the Go Digit TP rate is applied to; other liability lines such as LL to paid driver are only in Net Premium')
    ?? missing('No "Basic Third-Party Liability" amount found');
  p.netOd = f.policyType.value === 'satp'
    ? missing('Liability-only policy: there is no own-damage premium')
    : pick(pages, /(?:Net|Total)\s+(?:Own Damage|OD)\s+Premium\b(.*)$/i, (m) => money(m[1])) ?? missing('No own-damage premium total found');
  p.netPremium = pick(pages, /Net Premium\b[^\d]{0,8}?(\d[\d,]*\.\d{2})/i, (m) => parseMoney(m[1])) ?? missing('No "Net Premium" amount found');
  p.gst = pick(pages, /(?:CGST|SGST|IGST|\bGST\b).*@.*?(\d[\d,]*\.\d{2})\s*$/i, (m) => parseMoney(m[1]),
    'Total GST (last amount on the CGST + SGST line)') ?? missing('No GST amount found');
  p.total = pick(pages, /(?:Final|Total|Gross) Premium\b[^\d]{0,8}?(\d[\d,]*\.\d{2})/i, (m) => parseMoney(m[1])) ?? missing('No final premium found');
}

export function extract(pages: PageText[]): PolicyFacts {
  const f = emptyFacts();
  const name = findAll(pages, NAME_RE).find((h) => !/previous/i.test(h.line));
  if (name) {
    f.insurerName = found(name.line.match(/go\s*digit general insurance (?:ltd\.?|limited)/i)?.[0] ?? 'Go Digit General Insurance', name);
    f.insurer = found('godigit', name);
  }
  f.policyType = policyType(pages);
  previousInsurer(f, pages);

  f.registrationNumber = registration(pages);
  const mark = f.registrationNumber.value ? parseRegistration(f.registrationNumber.value) : null;
  if (mark) f.rtoCode = derived(mark.rtoCode, f.registrationNumber.evidence, `RTO code taken from registration number ${f.registrationNumber.value}`);
  f.rtoLocation = pick(pages, /RTO Location\s*[:|]?\s*(.+?)\s*(?:\|\s*)?(?:Seating\b.*|Capacity\b.*)?$/i, (m) => clean(m[1]) || null)
    ?? missing('No RTO location found');
  const state = f.rtoLocation.value ? stateIn(f.rtoLocation.value) : null;
  if (state) f.state = found(state, f.rtoLocation.evidence);
  else if (mark) f.state = derived(STATE_BY_CODE[mark.stateCode], f.registrationNumber.evidence, `State from the registration prefix ${mark.stateCode}`);

  const mm = findFirst(pages, /\bMake\s*[:|]?\s*(.+?)\s*\|?\s*Model\s*\/\s*Vehicle Variant(?:\s*\(Sub-Type\))?\s*[:|]?\s*(.*)$/i);
  if (mm) {
    f.make = found(clean(mm.match[1]), mm);
    if (clean(mm.match[2])) f.model = found(clean(mm.match[2]), mm);
  }
  f.cc = pick(pages, /Cubic Capacity\s*[:|]?\s*(\d{3,5})/i, (m) => Number(m[1])) ?? missing('No cubic capacity found');
  f.fuel = pick(pages, /Fuel Type\s*[:|]?\s*([A-Za-z][A-Za-z /+-]*?)\s*(?:\||Year of|$)/i, (m) => normaliseFuel(m[1])) ?? missing('No fuel type found');
  f.seats = pick(pages, /(?<!Cubic\s)Capacity\s*[:|]?\s*(\d{1,2})\s*$/i, (m) => Number(m[1])) ?? missing('Seating capacity not read');
  const kit = findFirst(pages, /TP for Bi-?fuel kit(.*)$/i);
  const kitPremium = kit ? money(kit.match[1]) : null;
  if (kit) {
    f.cngLpgKit = kitPremium
      ? found(true, kit, `Bi-fuel kit TP premium ${kitPremium} is charged`)
      : derived(false, [evidenceOf(kit)], 'The "TP for Bi-fuel kit" line carries no premium, so no CNG/LPG kit is covered');
  }

  f.policyStart = pickFlat(pages, new RegExp(String.raw`\bFrom\b[\s|:]*${DATE}`, 'i'), (m) => parseDate(m[1])) ?? missing('No policy start date found');
  f.policyEnd = pickFlat(pages, new RegExp(String.raw`\bTo\b[\s|:]*${DATE}`, 'i'), (m) => parseDate(m[1])) ?? missing('No policy end date found');
  vehicleDates(f, pages);

  f.ncbPercent = pick(pages, /(?:NCB|No Claim Bonus)[^\d%]{0,20}(\d{1,2})\s*%/i, (m) => Number(m[1]))
    ?? missing(f.policyType.value === 'satp' ? 'Liability-only policy: no own-damage section, so no NCB is printed' : 'No NCB printed');
  premium(f, pages);
  return f;
}
