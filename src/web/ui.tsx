import { useState, type ReactNode } from 'react';
import type { Citation } from '../core/types';

const TONE: Record<string, string> = {
  resolved: 'good', analysed: 'good', applicable: 'good', high: 'good', found: 'good',
  ambiguous: 'warn', awaiting_text: 'warn', uploading: 'warn', medium: 'warn',
  derived: 'info', user: 'info',
  unsupported: 'bad', failed: 'bad', low: 'bad', missing: 'bad',
  not_applicable: 'neutral',
};

const LABEL: Record<string, string> = {
  awaiting_text: 'awaiting text', not_applicable: 'not applicable', user: 'set by you',
};

export const toneOf = (value: string) => TONE[value] ?? 'neutral';

/** Status pill. Tone is never carried by colour alone: every tone has its own glyph. */
export function Badge({ value, title }: { value: string; title?: string }) {
  const tone = toneOf(value);
  return (
    <span className={`badge ${tone}`} title={title}>
      <Icon name={tone} size={12} />
      {LABEL[value] ?? value.replace(/_/g, ' ')}
    </span>
  );
}

const PATHS: Record<string, ReactNode> = {
  good: <path d="M5 10.5l3 3 7-7" />,
  warn: <><path d="M10 6v5" /><path d="M10 14.2v.1" /></>,
  bad: <path d="M6.5 6.5l7 7M13.5 6.5l-7 7" />,
  info: <><path d="M10 9v5" /><path d="M10 6.2v.1" /></>,
  neutral: <path d="M6 10h8" />,
  upload: <><path d="M10 13V4" /><path d="M6 8l4-4 4 4" /><path d="M4 13v3h12v-3" /></>,
  file: <><path d="M6 2.5h5.5L15 6v11.5H6z" /><path d="M11 2.5V6h4" /></>,
  doc: <><path d="M5 2.5h7l3 3v12H5z" /><path d="M8 9h5M8 12h5M8 15h3" /></>,
  grid: <><rect x="3" y="3" width="14" height="14" rx="1.5" /><path d="M3 8h14M3 12.5h14M8 3v14" /></>,
  spark: <path d="M10 3l1.6 4.4L16 9l-4.4 1.6L10 15l-1.6-4.4L4 9l4.4-1.6z" />,
  search: <><circle cx="9" cy="9" r="5" /><path d="M13 13l4 4" /></>,
  history: <><path d="M3.5 10a6.5 6.5 0 1 0 2-4.7" /><path d="M3 3.5v3h3" /><path d="M10 6.5V10l2.5 1.5" /></>,
  download: <><path d="M10 3v9" /><path d="M6 8l4 4 4-4" /><path d="M4 15.5h12" /></>,
  external: <><path d="M11 3.5h5.5V9" /><path d="M16.5 3.5L9 11" /><path d="M14 12v4.5H3.5V6H8" /></>,
  edit: <><path d="M4 16l1-4 8-8 3 3-8 8z" /><path d="M11.5 5.5l3 3" /></>,
  close: <path d="M5 5l10 10M15 5L5 15" />,
  trash: <><path d="M4 5.5h12" /><path d="M8 5.5V4h4v1.5" /><path d="M5.5 5.5l.8 11h7.4l.8-11" /><path d="M8.5 8.5v5M11.5 8.5v5" /></>,
  plus: <path d="M10 4v12M4 10h12" />,
  chevron: <path d="M7.5 5l5 5-5 5" />,
  question: <><path d="M7.5 7.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .8-1 1.5v.4" /><path d="M10 14.5v.1" /></>,
  stop: <path d="M6.5 6.5l7 7M13.5 6.5l-7 7" />,
  ok: <path d="M5 10.5l3 3 7-7" />,
};

export function Icon({ name, size = 16, className }: { name: string; size?: number; className?: string }) {
  return (
    <svg
      className={`icon ${className ?? ''}`}
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name] ?? PATHS.neutral}
    </svg>
  );
}

/** `Pvtcar!AB123 = 0.38` for workbooks, `p.1 Zone 2 >10-50k / Non-Petrol NCB = 17.50%` for PDF rate cards. */
export function citationText(c: Citation): string {
  const value = c.value ?? '—';
  if (c.sheet || c.cell) return `${[c.sheet, c.cell].filter(Boolean).join('!')} = ${value}`;
  const where = [c.table, [c.row, c.column].filter(Boolean).join(' / ')].filter(Boolean).join(' ');
  if (c.page != null) return `p.${c.page}${where ? ` ${where}` : ''} = ${value}`;
  return `${where || c.label} = ${value}`;
}

const fileName = (path: string) => path.split('/').pop() ?? path;

/** Grid-cell citations as monospace chips; long lists collapse behind "+N more". */
export function Citations({ items, limit = 4 }: { items?: Citation[]; limit?: number }) {
  const [open, setOpen] = useState(false);
  if (!items?.length) return null;
  const shown = open ? items : items.slice(0, limit);
  return (
    <span className="chips">
      {shown.map((c, i) => (
        <span key={i} className="chip mono" title={`${c.label ? `${c.label}\n` : ''}${fileName(c.file)}`}>
          {citationText(c)}
        </span>
      ))}
      {items.length > limit && (
        <button type="button" className="chip more" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? 'Show fewer' : `+${items.length - limit} more`}
        </button>
      )}
    </span>
  );
}
