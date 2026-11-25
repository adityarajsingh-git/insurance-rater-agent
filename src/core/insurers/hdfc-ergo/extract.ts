// HDFC ERGO private-car schedule extraction. The schedule (page 1) and the proposal transcript (page 3)
// print the same vehicle and premium blocks, so every pattern scans all pages and takes the first line that
// yields a value - a value OCR dropped on page 1 is picked up from the copy.
import {
  derived,
  emptyFacts,
  evidenceOf,
  findAll,
  findFirst,
  found,
  missing,
  moneyAll,
  normaliseFuel,
  parseDate,
  parseMoney,
  yearsBetween,
} from '../../extract/common';
import { parseRegistration, stateFromCode } from '../../geo';
import type { Fact, PageText, PolicyFacts, PolicyType } from '../../types';
import type { Detection } from '../module';

const ISSUER = /HDFC\s*ERGO\s+General\s+Insurance\s+Company|hdfcergo\.com/i;

export function detect(pages: PageText[]): Detection | null {
  const issuer = findFirst(pages, ISSUER);
  if (issuer) return { insurer: 'hdfc-ergo', score: 0.95, evidence: [evidenceOf(issuer)] };
  // A bare "HDFC ERGO" can be the previous insurer on another company's policy.
  const mention = findFirst(pages, /HDFC\s*ERGO/i);
  return mention ? { insurer: 'hdfc-ergo', score: 0.25, evidence: [evidenceOf(mention)] } : null;
}

/** First line matching `re` whose capture group 1 parses to a value. */
function first<T>(pages: PageText[], re: RegExp, parse: (s: string) => T | null, note?: string): Fact<T> | null {
  for (const hit of findAll(pages, re)) {
    const value = parse(hit.match[1]);
    if (value !== null) return found(value, hit, note);
  }
  return null;
}

const int = (s: string) => (/^\d+$/.test(s) ? Number(s) : null);
const text = (s: string) => s.trim() || null;

const POLICY_TITLE = /PRIVATE\s+CAR\s+(COMPREHENSIVE|PACKAGE|LIABILITY\s+ONLY|STAND[\s-]*ALONE\s+OWN\s+DAMAGE|OWN\s+DAMAGE)\s+POLICY/i;

function policyTypeOf(title: string): PolicyType {
  if (/LIABILITY/i.test(title)) return 'satp';
  if (/OWN\s+DAMAGE/i.test(title)) return 'saod';
  return 'package';
}

function policyType(pages: PageText[], netOd: Fact<number>, netTp: Fact<number>): Fact<PolicyType> {
  // The title, not "Liability only Cover", which a package schedule also prints for its TP period.
  const title = first(pages, POLICY_TITLE, policyTypeOf);
  if (title) return title;
  if (!findFirst(pages, /PRIVATE\s+CAR/i)) return missing('No private-car title found; this grid covers private cars only');
  const od = (netOd.value ?? 0) > 0;
  const tp = (netTp.value ?? 0) > 0;
  if (!od && !tp) return missing('No policy title and no premium split found');
  const type: PolicyType = od && tp ? 'package' : od ? 'saod' : 'satp';
  return derived(type, [...netOd.evidence, ...netTp.evidence], 'No policy title found; inferred from which premium components are printed');
}

function premium(pages: PageText[], label: RegExp, what: string): Fact<number> {
  return first(pages, new RegExp(label.source + String.raw`\s*\|?\s*([\d,]+(?:\.\d{1,2})?)`, 'i'), parseMoney)
    ?? missing(`${what} not found`);
}

function gst(pages: PageText[]): Fact<number> {
  const re = /\b(?:Integrated\s+Tax|IGST|CGST|SGST|UTGST)\b[^|\d]*\d{1,2}(?:\.\d+)?\s*%\s*\|?\s*([\d,]+(?:\.\d{1,2})?)/i;
  const hits = findAll(pages, re);
  if (!hits.length) return missing('GST line not found');
  // CGST + SGST print as two lines on the same page; IGST as one.
  const page = hits.filter((h) => h.page === hits[0].page);
  const sum = page.reduce((n, h) => n + (parseMoney(h.match[1]) ?? 0), 0);
  return found(Math.round(sum * 100) / 100, page.map((h) => evidenceOf(h)));
}

function previousInsurer(pages: PageText[]): Fact<string> {
  return first(pages, /Previous\s+Policy.*?\bof\s+([A-Z][A-Z0-9 .&]*?(?:LTD|LIMITED)\.?)(?=\s|\||$)/i, text)
    ?? first(pages, /Previous\s+Insurer(?:\s+Name)?\s*[:|]\s*\|?\s*([A-Za-z][A-Za-z .&]+)/i, text)
    ?? missing('No previous-policy insurer printed');
}

function businessType(pages: PageText[], prev: Fact<string>): PolicyFacts['businessType'] {
  if (prev.value) {
    const same = /hdfc\s*ergo/i.test(prev.value);
    return derived(same ? 'renewal' : 'rollover', prev.evidence,
      same ? 'Previous insurer is HDFC ERGO, the same insurer' : `Previous insurer ${prev.value} differs from HDFC ERGO`);
  }
  const fresh = findFirst(pages, /\b(New\s+Business|Brand\s+New)\b/i);
  return fresh
    ? derived('new', [evidenceOf(fresh)], 'Printed as new business / brand-new vehicle')
    : missing('No previous-policy details printed');
}

/** Kit IDV is 0 when the total IDV equals the vehicle IDV on the "From .. To .." IDV row. */
function cngLpgKit(pages: PageText[]): Fact<boolean> {
  for (const hit of findAll(pages, /From\s+\d{2}\/\d{2}\/\d{4}\s+To\s+\d{2}\/\d{2}\/\d{4}(.*)$/)) {
    const idv = moneyAll(hit.match[1]);
    if (idv.length >= 2 && idv[0] > 0 && idv[0] === idv.at(-1)) {
      return derived(false, [evidenceOf(hit)], 'Total IDV equals the vehicle IDV, so the CNG/LPG kit IDV is 0');
    }
  }
  return missing('CNG/LPG kit IDV not readable');
}

function fuel(pages: PageText[], model: Fact<string>): PolicyFacts['fuel'] {
  const printed = first(pages, /\bFuel(?:\s*Type)?\s*[:|]?\s*\|?\s*(Petrol|Diesel|CNG|LPG|Electric|Battery|Hybrid)\b/i, normaliseFuel);
  if (printed) return printed;
  const fromModel = model.value ? normaliseFuel(model.value) : null;
  if (fromModel) return derived(fromModel, model.evidence, 'Fuel word in the model name');
  return missing('The schedule prints no fuel type, and the model name has no fuel word');
}

export function extract(pages: PageText[]): PolicyFacts {
  const facts = emptyFacts();
  const p = facts.premium;
  p.netOd = premium(pages, /Net\s+Own\s+Damage\s+Premium\s*\(a\)/, 'Net own-damage premium');
  p.netTp = premium(pages, /Net\s+Liability\s+Premium\s*\(b\)/, 'Net liability premium');
  p.netPremium = premium(pages, /Total\s+Package\s+Premium\s*\(a\s*\+\s*b\)/, 'Total package premium');
  p.total = premium(pages, /\bTotal\s+Premium/, 'Total premium');
  p.gst = gst(pages);

  const issuer = findFirst(pages, /HDFC\s*ERGO\s+General\s+Insurance\s+Company\s+Limited/i);
  if (issuer) {
    facts.insurerName = found('HDFC ERGO General Insurance Company Limited', issuer);
    facts.insurer = found('hdfc-ergo' as const, issuer);
  }
  facts.policyType = policyType(pages, p.netOd, p.netTp);
  facts.previousInsurer = previousInsurer(pages);
  facts.businessType = businessType(pages, facts.previousInsurer);

  facts.make = first(pages, /\bMake\s*\|?\s*([A-Z][A-Z0-9&.\- ]*?)\s*(?:\||Policy No|Proposal No|$)/, text) ?? missing('Make not found');
  facts.model = first(pages, /\bModel\s*\|?\s*(.+?)\s*(?:\||Period of|$)/, text) ?? missing('Model not found');
  facts.fuel = fuel(pages, facts.model);
  facts.cngLpgKit = cngLpgKit(pages);
  facts.cc = first(pages, /Cubic\s*Capacity\D{0,12}?(\d{3,5})\b/i, int) ?? missing('Cubic capacity not found');
  facts.seats = first(pages, /\bSeats\s*\|?\s*(\d{1,2})\b/, int) ?? missing('Seat count not readable');
  facts.manufactureYear = first(pages, /Year\s+of\s+Manufacture\D{0,8}((?:19|20)\d{2})\b/i, int) ?? missing('Year of manufacture not found');
  facts.registrationDate = first(pages, /\b(?:Registration|Regn\.?)\s+Date\s*[:|]?\s*\|?\s*(.{6,20})/i, parseDate) ?? missing('Registration date not printed');

  const reg = first(pages, /Registration\s*No\.?\s*\|?\s*([A-Z]{2}[\s-]*\d{1,2}[\s-]*[A-Z0-9]{0,4}[\s-]*\d{1,4})\b/, text);
  const mark = reg?.value ? parseRegistration(reg.value) : null;
  if (reg && mark) {
    // OCR sometimes reads a series letter as a digit ("HR-26-FB8-8239"). The state code and district come before
    // the series, so the RTO still stands, but a mark that does not parse end to end is left missing for the
    // contrast-enhanced OCR pass (src/core/agent.ts) to supply.
    const marks = (s: string) => s.replace(/[\s-]/g, '');
    facts.registrationNumber =
      marks(mark.raw) === marks(reg.value!) ? reg : missing(`Registration number partly unreadable ("${reg.value}")`);
    facts.rtoCode = found(mark.rtoCode, reg.evidence, 'State code and district number of the registration mark');
    facts.state = derived(stateFromCode(mark.stateCode) ?? mark.stateCode, reg.evidence, `State of registration code ${mark.stateCode}`);
  } else {
    facts.registrationNumber = missing('Registration number not readable');
    facts.rtoCode = missing('Registration number not readable');
    facts.state = missing('Registration number not readable');
  }
  facts.rtoLocation = first(pages, /\bRTO\s*\|?\s*([A-Z][A-Za-z .]+?)\s*(?:\||Issuance|$)/, text) ?? missing('RTO location not found');

  facts.ncbPercent = first(pages, /No\s+Claim\s+Bonus\s*\(\s*(\d{1,2})\s*%\s*\)/i, int)
    ?? missing('No "No Claim Bonus (x%)" line; the NCB box on the previous-policy row is the old policy\'s NCB');

  const period = findFirst(pages, /From\s+(\d{2}\/\d{2}\/\d{4})\s+To\s+(\d{2}\/\d{2}\/\d{4})/);
  const start = parseDate(period?.match[1]);
  const end = parseDate(period?.match[2]);
  facts.policyStart = period && start ? found(start, period) : first(pages, /Period\s+of\b.*?From\s+(\d{1,2}\s+[A-Za-z]{3},?\s+\d{4})/, parseDate) ?? missing('Policy start not found');
  facts.policyEnd = period && end ? found(end, period) : first(pages, /\bTo\s+(\d{1,2}\s+[A-Za-z]{3},?\s+\d{4})/, parseDate) ?? missing('Policy end not found');

  const startIso = facts.policyStart.value;
  const regIso = facts.registrationDate.value;
  const year = facts.manufactureYear.value;
  facts.vehicleAgeYears = startIso && regIso
    ? derived(yearsBetween(regIso, startIso), [...facts.registrationDate.evidence, ...facts.policyStart.evidence], 'Whole years from registration to policy start')
    : startIso && year
    ? derived(Number(startIso.slice(0, 4)) - year, [...facts.manufactureYear.evidence, ...facts.policyStart.evidence],
      `Policy start year minus year of manufacture ${year}; the manufacture month is not printed`)
    : missing('Needs year of manufacture and policy start');
  return facts;
}
