// RTO -> Pvtcar location column (spec §3.4). Columns mix cities, states and sub-state clusters whose
// membership the workbook never defines. City beats state; a state split into clusters stays unknown
// among its candidate columns. Matching is exact after squashing, plus an explicit alias table.
import { squash, stateCodeFromName, stateFromCode } from '../../geo';
import type { PolicyFacts } from '../../types';

export interface LocationPick {
  columns: string[]; // Pvtcar row-5 headers; empty = no column reachable
  detail: string;
  /** No location fact at all: every column is a candidate and the user must be asked. */
  unknown?: boolean;
}

// Spelling variants -> header. Headers themselves match after squash().
const CITY_ALIASES: Record<string, string> = {
  bengaluru: 'BANGALORE',
  bhubaneswar: 'BHUBANESHWAR',
  madras: 'CHENNAI',
  newdelhi: 'DELHI',
  calcutta: 'KOLKATA',
  bombay: 'MUMBAI',
  poona: 'PUNE',
  baroda: 'Vadodara',
  vijayawada: 'VIJAYWADA',
  visakhapatnam: 'VISHAKAPATNAM',
  vizag: 'VISHAKAPATNAM',
  andhrapradesh: 'Andra Pradesh',
  telangana: 'Telengana',
  jammuandkashmir: 'Jammu & Kashmir',
};

/** Per registration-state code: its state column, its city columns, its undefined-membership clusters. */
const STATE_COLUMNS: Record<string, { state?: string; cities?: string[]; clusters?: string[] }> = {
  DL: { state: 'DELHI' }, // one territory: every DL RTO uses the DELHI column
  CH: { state: 'CHANDIGARH' },
  AP: { state: 'Andra Pradesh', cities: ['VIJAYWADA', 'VISHAKAPATNAM'] },
  BR: { state: 'BIHAR' },
  CG: { state: 'Chhattisgarh' },
  GA: { state: 'GOA' },
  HR: { state: 'HARYANA' },
  HP: { state: 'Himachal Pradesh' },
  JK: { state: 'Jammu & Kashmir' },
  JH: { state: 'JHARKHAND' },
  KL: { state: 'KERALA' },
  TS: { state: 'Telengana', cities: ['HYDERABAD'] },
  TG: { state: 'Telengana', cities: ['HYDERABAD'] },
  UK: { state: 'UTTARAKHAND' },
  UA: { state: 'UTTARAKHAND' },
  KA: { cities: ['BANGALORE'], clusters: ['KA1', 'KA2'] },
  MP: { cities: ['INDORE'], clusters: ['MP1', 'MP2', 'MP3'] },
  PB: { clusters: ['PB1', 'PB2'] },
  RJ: { cities: ['JAIPUR'], clusters: ['RJ1', 'RJ2', 'RJ3', 'RJ4', 'RJ5'] },
  UP: { clusters: ['UP1', 'UP2', 'UP3'] },
  MH: { cities: ['MUMBAI', 'NAGPUR', 'PUNE'], clusters: ['ROM1', 'ROM2', 'ROM3', 'ROM4'] },
  GJ: { cities: ['AHMEDABAD', 'SURAT', 'RAJKOT', 'Vadodara'], clusters: ['ROGJ'] },
  TN: { cities: ['CHENNAI', 'COIMBATORE'], clusters: ['ROTN'] },
  WB: { cities: ['KOLKATA'], clusters: ['ROWB', 'ROWB2'] },
  OD: { cities: ['BHUBANESHWAR'], clusters: ['ROOD'] },
  OR: { cities: ['BHUBANESHWAR'], clusters: ['ROOD'] },
};

const usable = <T>(f: { value: T | null; status: string }): T | null =>
  f.value !== null && f.status !== 'missing' && f.status !== 'ambiguous' ? f.value : null;

/** Header named by `name` (exact after squash, or alias), or null. */
export function headerFor(name: string, headers: string[]): string | null {
  const key = squash(name);
  return headers.find((h) => squash(h) === key) ?? CITY_ALIASES[key] ?? null;
}

export function locate(facts: PolicyFacts, headers: string[]): LocationPick {
  const rtoLocation = usable(facts.rtoLocation);
  const rtoCode = usable(facts.rtoCode);
  const stateName = usable(facts.state);

  if (rtoLocation) {
    const header = headerFor(rtoLocation, headers);
    if (header) return { columns: [header], detail: `RTO location "${rtoLocation}" has its own column ${header}.` };
  }

  const code = rtoCode?.slice(0, 2).toUpperCase()
    ?? (stateName ? stateCodeFromName(stateName) : null)
    ?? (rtoLocation ? stateCodeFromName(rtoLocation) : null);
  const via = rtoCode ? `RTO code ${rtoCode}` : stateName ? `state ${stateName}` : `RTO location ${rtoLocation}`;

  if (!code || !stateFromCode(code)) {
    if (!rtoLocation && !rtoCode && !stateName) {
      return { columns: [...headers], unknown: true, detail: 'No RTO code, RTO location or state on the policy: every location column is a candidate.' };
    }
    return { columns: [], detail: `${via} matches no Pvtcar column and no Indian registration state.` };
  }

  const state = stateFromCode(code);
  const cols = STATE_COLUMNS[code];
  if (!cols) return { columns: [], detail: `${via} -> ${state}: Pvtcar has no column for this state.` };

  // A printed RTO location that is not a city column rules the city columns out.
  const cities = rtoLocation ? [] : (cols.cities ?? []);
  const columns = [...(cols.state ? [cols.state] : cols.clusters ?? []), ...cities];
  const why = cols.state
    ? `state column ${cols.state}`
    : `clusters ${cols.clusters?.join(', ')} (the workbook never says which RTOs belong to which cluster)`;
  const cityNote = cities.length ? `; the RTO city is not printed, so city columns ${cities.join(', ')} stay candidates` : '';
  return { columns, detail: `${via} -> ${state} -> ${why}${cityNote}.` };
}
