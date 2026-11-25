// Build-time normaliser for the HDFC ERGO private-car grid (a 2-page PDF). Reads the pdf.js text layer with
// item positions, rebuilds the two zone rate tables, the footnotes and the state -> zone map, and writes
// src/data/grids/hdfc-ergo.json. Throws when the layout drifts from the spec instead of emitting a wrong grid.
// Usage: npx tsx scripts/grids/hdfc-ergo.ts
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { stateCodeFromName, stateFromCode } from '../../src/core/geo';

export const FILE = "raters/hdfc-ergo/feb-2025/Pvt Car New Grid Eff 1st Feb'25 (HDFC ergo) 1.pdf";
export const OUT = 'src/data/grids/hdfc-ergo.json';

const SLABS = ['<10k', '>10-50k', '>50k-1L', '>1L-2L', '>2L'];
const COLUMNS = [
  'Package / Petrol / NCB & N-NCB',
  'Package / Non-Petrol / NCB',
  'Package / Non-Petrol / N-NCB',
  'SAOD / Petrol / NCB & N-NCB',
  'SAOD / Non-Petrol / NCB',
  'SAOD / Non-Petrol / N-NCB',
];
const FOOTNOTES = {
  slab: 'Slab will be calculated basis comprehensive + SAOD GWP on PVT CAR (SATP premium is excluded for slab achievement)',
  nonPetrol: '*Non Petrol includes Diesel, CNG, LPG',
  newBusiness: '#New Business will be considered as NCB',
  evHybrid: '# EV and Hybrid is to be considered in Petrol Grid',
};
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

interface Item {
  page: number;
  x: number;
  y: number;
  w: number;
  str: string;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`hdfc-ergo grid: ${msg}`);
}

const centre = (i: Item) => i.x + i.w / 2;
const nearest = (target: Item, pool: Item[]) =>
  pool.reduce((a, b) => (Math.abs(centre(b) - centre(target)) < Math.abs(centre(a) - centre(target)) ? b : a));

async function readItems(path: string): Promise<{ items: Item[]; pages: number }> {
  const doc = await getDocument({ data: new Uint8Array(readFileSync(path)), verbosity: 0 }).promise;
  const items: Item[] = [];
  for (let page = 1; page <= doc.numPages; page++) {
    const { items: raw } = await (await doc.getPage(page)).getTextContent();
    for (const it of raw) {
      if ('str' in it && it.str.trim()) items.push({ page, x: it.transform[4], y: it.transform[5], w: it.width, str: it.str.trim() });
    }
  }
  return { items, pages: doc.numPages };
}

/** Items grouped into visual rows (same baseline within 2pt), top to bottom. */
function rows(items: Item[]): Item[][] {
  const out: Item[][] = [];
  for (const it of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const row = out.at(-1);
    if (row && Math.abs(row[0].y - it.y) < 2) row.push(it);
    else out.push([it]);
  }
  return out;
}

function effective(p1: Item[]) {
  const item = p1.find((i) => /^Effective from/i.test(i.str));
  const m = item?.str.match(/^Effective from (\d{1,2})(?:st|nd|rd|th)? ([A-Za-z]{3})'(\d{2})$/);
  assert(item && m && MONTHS.includes(m[2].toLowerCase()), `effective-date header changed: ${item?.str}`);
  const month = String(MONTHS.indexOf(m[2].toLowerCase()) + 1).padStart(2, '0');
  return { from: `20${m[3]}-${month}-${m[1].padStart(2, '0')}`, text: item.str, page: 1 };
}

function footnotes(p1: Item[]) {
  const out = {} as Record<keyof typeof FOOTNOTES, { page: number; text: string; y: number }>;
  for (const [key, text] of Object.entries(FOOTNOTES) as [keyof typeof FOOTNOTES, string][]) {
    const item = p1.find((i) => i.str === text);
    assert(item, `footnote "${key}" not found verbatim: ${text}`);
    out[key] = { page: 1, text, y: item.y };
  }
  return out;
}

function rateTables(p1: Item[], bottomOfLast: number) {
  const titles = p1.filter((i) => /^Zone [12]$/.test(i.str)).sort((a, b) => b.y - a.y);
  assert(titles.map((t) => t.str).join() === 'Zone 1,Zone 2', `expected rate tables "Zone 1", "Zone 2", got ${titles.map((t) => t.str)}`);
  const rates = [];
  for (const [t, title] of titles.entries()) {
    const bottom = titles[t + 1]?.y ?? bottomOfLast;
    const band = p1.filter((i) => i.y < title.y && i.y > bottom);
    const categories = band.filter((i) => /^(Package|SAOD)$/.test(i.str));
    const fuels = band.filter((i) => /^(Non\s*-\s*)?Petrol$/.test(i.str));
    const ncbHeads = band.filter((i) => /^(NCB & N-NCB|NCB|N-NCB)$/.test(i.str)).sort((a, b) => a.x - b.x);
    assert(categories.length === 2 && fuels.length === 4 && ncbHeads.length === 6, `${title.str}: header cells moved`);
    const columns = ncbHeads.map((head) => {
      const fuel = nearest(head, fuels);
      return {
        head,
        category: nearest(fuel, categories).str,
        fuel: fuel.str === 'Petrol' ? 'Petrol' : 'Non-Petrol',
        ncb: head.str,
      };
    });
    const labels = columns.map((c) => `${c.category} / ${c.fuel} / ${c.ncb}`);
    assert(labels.join('|') === COLUMNS.join('|'), `${title.str}: columns changed: ${labels.join(' | ')}`);

    const slabItems = band.filter((i) => /^[<>]/.test(i.str)).sort((a, b) => b.y - a.y);
    assert(slabItems.map((s) => s.str).join('|') === SLABS.join('|'), `${title.str}: slab rows changed: ${slabItems.map((s) => s.str)}`);
    for (const slab of slabItems) {
      const values = band.filter((i) => i !== slab && Math.abs(i.y - slab.y) < 2);
      assert(
        values.length === 6 && values.every((v) => /^\d+(\.\d+)?%$/.test(v.str)),
        `${title.str} row ${slab.str}: expected 6 percentages (no decline markers), got ${values.map((v) => v.str)}`,
      );
      const used = new Set<number>();
      for (const v of values) {
        const c = ncbHeads.indexOf(nearest(v, ncbHeads));
        assert(!used.has(c), `${title.str} row ${slab.str}: two values under ${labels[c]}`);
        used.add(c);
        const col = columns[c];
        rates.push({
          zone: title.str,
          category: col.category,
          fuel: col.fuel,
          ncb: col.ncb,
          slab: slab.str,
          percent: Number(v.str.slice(0, -1)),
          raw: v.str,
          page: 1,
          column: labels[c],
        });
      }
    }
  }
  return rates;
}

function zoneMap(items: Item[], pages: number) {
  const out = [];
  for (let page = 1; page <= pages; page++) {
    const onPage = items.filter((i) => i.page === page);
    const head = ['Zone', 'State Name', 'Zone-1', 'Zone-2'].map((h) => onPage.find((i) => i.str === h));
    assert(head.every(Boolean), `page ${page}: state-to-zone header "Zone | State Name | Zone-1 | Zone-2" not found`);
    const [region, stateCol, zone1, zone2] = head as Item[];
    let regionText = '';
    let stateText = '';
    for (const row of rows(onPage.filter((i) => i.y < region.y - 2))) {
      const cells = [];
      for (const it of row) {
        const col = nearest(it, head as Item[]);
        if (col === region) regionText = it.str;
        else if (col === stateCol) stateText = it.str;
        else cells.push({ it, col });
      }
      assert(cells.length >= 1 && regionText && stateText, `page ${page} y=${row[0].y}: zone row without region/state/zone cell`);
      for (const { it, col } of cells) {
        const code = stateCodeFromName(stateText);
        out.push({
          region: regionText,
          stateText,
          state: code ? stateFromCode(code) : null, // canonical name; null for NCR
          place: it.str,
          zone: col === zone1 ? 'Zone 1' : 'Zone 2',
          column: col === zone1 ? zone1.str : zone2.str,
          page,
        });
      }
    }
  }
  return out;
}

export async function build() {
  const { items, pages } = await readItems(FILE);
  assert(pages === 2, `expected 2 pages, got ${pages}`);
  const p1 = items.filter((i) => i.page === 1);
  const notes = footnotes(p1);
  const rates = rateTables(p1, notes.slab.y);
  const zones = zoneMap(items, pages);

  // Spec section 4: the sample's decisive cells and zone rows.
  const col = (zone: string, column: string) => rates.filter((r) => r.zone === zone && r.column === column).map((r) => r.percent);
  for (const c of ['Package / Petrol / NCB & N-NCB', 'Package / Non-Petrol / NCB']) {
    assert(col('Zone 2', c).join() === '15,17.5,20,22,23', `Zone 2 ${c} changed: ${col('Zone 2', c)}`);
  }
  const zoneOf = (place: string) => zones.filter((z) => z.place === place).map((z) => `${z.zone}@p${z.page}`).join();
  assert(zoneOf('Haryana') === 'Zone 2@p2', `Haryana zone changed: ${zoneOf('Haryana')}`);
  assert(zoneOf('Delhi') === 'Zone 1@p2', `Delhi zone changed: ${zoneOf('Delhi')}`);
  assert(zones.length === 40, `expected 40 zone cells, got ${zones.length}`);

  const strip = ({ page, text }: { page: number; text: string }) => ({ page, text });
  return {
    source: {
      file: FILE,
      sha256: createHash('sha256').update(readFileSync(FILE)).digest('hex'),
      pages,
      effective: effective(p1),
    },
    slabs: SLABS,
    footnotes: {
      slab: strip(notes.slab),
      nonPetrol: strip(notes.nonPetrol),
      newBusiness: strip(notes.newBusiness),
      evHybrid: strip(notes.evHybrid),
    },
    rates,
    zoneMap: zones,
  };
}

/** Objects on one line each inside arrays, so the file stays small and diffs stay readable. */
export function serialise(grid: Record<string, unknown>): string {
  const body = Object.entries(grid).map(([k, v]) =>
    Array.isArray(v) && typeof v[0] === 'object'
      ? `  ${JSON.stringify(k)}: [\n${v.map((e) => `    ${JSON.stringify(e)}`).join(',\n')}\n  ]`
      : `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`,
  );
  return `{\n${body.join(',\n')}\n}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  writeFileSync(OUT, serialise(await build()));
  console.log(`wrote ${OUT}`);
}
