import type { Citation } from '../core/types';

export const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export const fmtRate = (r: number | null | undefined) => (r == null ? '—' : `${r}%`);

export const fmtRupees = (n: number | null | undefined) =>
  n == null ? '—' : `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const BADGE_TONE: Record<string, string> = {
  resolved: 'good', analysed: 'good', applicable: 'good', high: 'good', found: 'good',
  ambiguous: 'warn', awaiting_text: 'warn', uploading: 'warn', medium: 'warn', derived: 'info', user: 'info',
  unsupported: 'bad', failed: 'bad', low: 'bad', missing: 'bad', not_applicable: 'neutral',
};

export function Badge({ value }: { value: string }) {
  return <span className={`badge ${BADGE_TONE[value] ?? 'neutral'}`}>{value.replace(/_/g, ' ')}</span>;
}

/** `Pvtcar!AB123 = 0.38` for workbooks, `p.1 Zone 2 >10-50k / Non-Petrol NCB = 17.50%` for PDF rate cards. */
export function citationText(c: Citation): string {
  const value = c.value ?? '—';
  if (c.sheet || c.cell) return `${[c.sheet, c.cell].filter(Boolean).join('!')} = ${value}`;
  const where = [c.table, [c.row, c.column].filter(Boolean).join(' / ')].filter(Boolean).join(' ');
  if (c.page != null) return `p.${c.page}${where ? ` ${where}` : ''} = ${value}`;
  return `${where || c.label} = ${value}`;
}

export function Citations({ items }: { items?: Citation[] }) {
  if (!items?.length) return null;
  return (
    <span className="chips">
      {items.map((c, i) => (
        <span key={i} className="chip" title={`${c.file}${c.label ? `\n${c.label}` : ''}`}>
          {citationText(c)}
        </span>
      ))}
    </span>
  );
}
