// Registration-mark geography: state codes of Indian vehicle registration marks and
// helpers to normalise an RTO code (HR-26, DL-9, UP-16) from a registration number.

export const STATE_BY_CODE: Record<string, string> = {
  AN: 'Andaman and Nicobar Islands',
  AP: 'Andhra Pradesh',
  AR: 'Arunachal Pradesh',
  AS: 'Assam',
  BR: 'Bihar',
  CG: 'Chhattisgarh',
  CH: 'Chandigarh',
  DD: 'Dadra and Nagar Haveli and Daman and Diu',
  DN: 'Dadra and Nagar Haveli and Daman and Diu',
  DL: 'Delhi',
  GA: 'Goa',
  GJ: 'Gujarat',
  HP: 'Himachal Pradesh',
  HR: 'Haryana',
  JH: 'Jharkhand',
  JK: 'Jammu and Kashmir',
  KA: 'Karnataka',
  KL: 'Kerala',
  LA: 'Ladakh',
  LD: 'Lakshadweep',
  MH: 'Maharashtra',
  ML: 'Meghalaya',
  MN: 'Manipur',
  MP: 'Madhya Pradesh',
  MZ: 'Mizoram',
  NL: 'Nagaland',
  OD: 'Odisha',
  OR: 'Odisha',
  PB: 'Punjab',
  PY: 'Puducherry',
  RJ: 'Rajasthan',
  SK: 'Sikkim',
  TN: 'Tamil Nadu',
  TR: 'Tripura',
  TS: 'Telangana',
  TG: 'Telangana',
  UK: 'Uttarakhand',
  UA: 'Uttarakhand',
  UP: 'Uttar Pradesh',
  WB: 'West Bengal',
};

/** Lower-case, alphanumerics only - for tolerant label comparison. */
export function squash(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function stateFromCode(code: string): string | null {
  return STATE_BY_CODE[code.toUpperCase()] ?? null;
}

export function stateCodeFromName(name: string): string | null {
  const n = squash(name);
  const aliases: Record<string, string> = {
    jk: 'JK',
    jammukashmir: 'JK',
    jammuandkashmir: 'JK',
    orissa: 'OD',
    pondicherry: 'PY',
    uttaranchal: 'UK',
    newdelhi: 'DL',
    nctofdelhi: 'DL',
  };
  if (aliases[n]) return aliases[n];
  for (const [code, state] of Object.entries(STATE_BY_CODE)) if (squash(state) === n) return code;
  return null;
}

export interface RegistrationMark {
  raw: string;
  stateCode: string;
  district: number;
  rtoCode: string; // e.g. HR-26 (Delhi: DL-9 - the letter after the number is a vehicle class, not part of the RTO)
  normalised: string;
}

const REG_RE = /\b([A-Z]{2})[\s-]*0?(\d{1,2})[\s-]*([A-Z]{0,3})[\s-]*(\d{1,4})\b/;

/** Parses a registration mark such as "HR-26-FB-8239", "DL 9C AB 1234", "UP78FN8239". */
export function parseRegistration(text: string): RegistrationMark | null {
  const m = text.toUpperCase().replace(/[–—]/g, '-').match(REG_RE);
  if (!m) return null;
  const [, sc, dist, series, num] = m;
  if (!STATE_BY_CODE[sc]) return null;
  const district = Number(dist);
  return {
    raw: m[0],
    stateCode: sc,
    district,
    rtoCode: `${sc}-${district}`,
    normalised: [sc, String(district).padStart(2, '0'), series, num].filter(Boolean).join('-'),
  };
}

/** Normalises an RTO code written as "UP78", "UP-78", "up 078", "DL9C" to "UP-78" / "DL-9". */
export function normaliseRtoCode(code: string): string | null {
  const m = code.toUpperCase().match(/^\s*([A-Z]{2})[\s-]*0*(\d{1,3})[A-Z]?\s*$/);
  if (!m || !STATE_BY_CODE[m[1]]) return null;
  return `${m[1]}-${Number(m[2])}`;
}
