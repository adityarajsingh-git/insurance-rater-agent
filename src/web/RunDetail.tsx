import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { AnalysisResult, ClarifyingQuestion, Fact, FactKey, FactOverrides, PolicyFacts, RateComponent, RateResult } from '../core/types';
import type { RunRecord } from '../server/runs';
import {
  FACT_INPUTS, STATUS_HINT, fmtBytes, fmtDate, fmtDay, fmtRate, fmtRupees, insurerName, needsAttention, policyTypeLabel,
  rateDisplay, toInputValue, totalBrokerage, verdictHeadline,
} from './format';
import { Progress, type Job } from './Progress';
import { Badge, Citations, Icon } from './ui';

const FACT_LABELS: Record<FactKey, string> = {
  insurerName: 'Insurer name', insurer: 'Insurer', policyType: 'Policy type', businessType: 'Business type',
  previousInsurer: 'Previous insurer', make: 'Make', model: 'Model', fuel: 'Fuel', cngLpgKit: 'CNG/LPG kit',
  cc: 'Engine cc', seats: 'Seats', manufactureYear: 'Manufacture year', registrationDate: 'Registration date',
  vehicleAgeYears: 'Vehicle age (years)', registrationNumber: 'Registration number', rtoCode: 'RTO code',
  rtoLocation: 'RTO location', state: 'State', ncbPercent: 'NCB %', covers: 'Add-on covers', gwpSlab: 'GWP slab (broker)',
  policyStart: 'Policy start', policyEnd: 'Policy end',
  'premium.netOd': 'Net OD premium', 'premium.netTp': 'Net TP premium', 'premium.netPremium': 'Net premium',
  'premium.gst': 'GST', 'premium.total': 'Total payable',
};

const fmtValue = (v: unknown, key: string) =>
  v == null || (Array.isArray(v) && !v.length)
    ? '—'
    : Array.isArray(v)
      ? v.join(', ')
      : typeof v === 'boolean'
        ? (v ? 'Yes' : 'No')
        : key.startsWith('premium.') && typeof v === 'number'
          ? fmtRupees(v)
          : String(v);

const factRowsOf = (facts: PolicyFacts): [FactKey, Fact<unknown>][] => [
  ...(Object.entries(facts).filter(([k]) => k !== 'premium') as [FactKey, Fact<unknown>][]),
  ...(Object.entries(facts.premium).map(([k, f]) => [`premium.${k}`, f]) as [FactKey, Fact<unknown>][]),
];

type Tab = 'trace' | 'facts' | 'pdf';

interface Props {
  run: RunRecord;
  job: Job | null;
  busy: boolean;
  onResumeUpload: (file: File) => void;
  onResumeExtract: () => void;
  onAnswer: (overrides: FactOverrides) => void;
  getPdf: () => Promise<Blob>;
  onDelete: () => void;
}

export function RunDetail({ run, job, busy, onResumeUpload, onResumeExtract, onAnswer, getPdf, onDelete }: Props) {
  const latestRev = run.analyses.length - 1;
  const [rev, setRev] = useState(latestRev);
  useEffect(() => setRev(run.analyses.length - 1), [run.analyses.length]); // jump to a new revision when it lands
  const analysis = run.analyses[rev];
  const latest = rev === latestRev;
  const [tab, setTab] = useState<Tab>('trace');
  const [pdfPage, setPdfPage] = useState<number | undefined>();
  const openPage = (page: number) => (setPdfPage(page), setTab('pdf'));
  const ocrPages = run.pages.filter((p) => p.source === 'ocr').length;
  const facts = analysis?.facts;

  const meta = [
    facts && (facts.insurerName.value ?? insurerName(facts.insurer.value)),
    facts && policyTypeLabel(facts.policyType.value, 'long'),
    run.pages.length > 0 && `${run.pages.length} pages${ocrPages ? ` (${ocrPages} OCR)` : ''}`,
    fmtBytes(run.fileSize),
    fmtDate(run.createdAt),
  ].filter(Boolean);

  return (
    <article className="detail">
      <header className="run-head">
        <div className="run-title">
          <span className="file-icon" aria-hidden="true"><Icon name="doc" size={20} /></span>
          <div>
            <h1 title={run.fileName}>{run.fileName}</h1>
            <div className="meta">{meta.join(' · ')}</div>
          </div>
        </div>
        <div className="run-actions">
          {analysis && run.analyses.length > 1 && (
              <label className="select-wrap">
                <span className="visually-hidden">Revision</span>
                <select value={rev} onChange={(e) => setRev(Number(e.target.value))}>
                  {run.analyses.map((a, i) => (
                    <option key={i} value={i}>
                      Revision {i + 1} of {run.analyses.length}{i === latestRev ? ' (latest)' : ''} · {fmtDate(a.analysedAt)}
                    </option>
                  ))}
                </select>
              </label>
            )}
          {analysis && (
            <button
              className="ghost"
              title={`Analysis JSON, engine ${analysis.engineVersion}`}
              onClick={() => downloadJson(analysis, `${run.fileName.replace(/\.pdf$/i, '')}-analysis-r${rev + 1}.json`)}
            >
              <Icon name="download" /> JSON
            </button>
          )}
          <button
            className="ghost danger"
            disabled={!!job}
            title={job ? 'Wait for the current step to finish' : 'Delete this analysis and its stored PDF'}
            onClick={onDelete}
          >
            <Icon name="trash" /> <span className="hide-sm">Delete</span>
          </button>
        </div>
      </header>

      {job ? (
        <Progress job={job} />
      ) : (
        <RunBanners run={run} busy={busy} onResumeUpload={onResumeUpload} onResumeExtract={onResumeExtract} onAnswer={onAnswer} />
      )}

      {analysis && (
        <>
          {!latest && (
            <div className="alert info">
              <Icon name="history" />
              <span>You are looking at revision {rev + 1}. Revision {latestRev + 1} reflects your latest answers.</span>
              <button className="link" onClick={() => setRev(latestRev)}>Show latest</button>
            </div>
          )}
          <Verdict result={analysis.result} />
          {latest && analysis.result.questions.length > 0 && (
            <Questions key={analysis.analysedAt} questions={analysis.result.questions} busy={busy} onAnswer={onAnswer} />
          )}
          <Snapshot facts={analysis.facts} onShowAll={() => setTab('facts')} />
        </>
      )}

      {run.status !== 'uploading' && (
        <section className="card tabs-card">
          <Tabs
            tab={analysis ? tab : 'pdf'}
            onTab={setTab}
            items={[
              ...(analysis
                ? [
                    { id: 'trace' as const, label: 'Decision trace', short: 'Trace', count: analysis.result.trace.length },
                    { id: 'facts' as const, label: 'Extracted facts', short: 'Facts', count: factRowsOf(analysis.facts).filter(([, f]) => needsAttention(f.status)).length, countTone: 'warn' },
                  ]
                : []),
              { id: 'pdf' as const, label: 'Policy PDF', short: 'PDF' },
            ]}
          />
          {analysis && tab === 'trace' && <Trace result={analysis.result} />}
          {analysis && tab === 'facts' && (
            <Facts analysis={analysis} editable={latest && !busy} onAnswer={onAnswer} onPage={openPage} />
          )}
          <PdfPanel active={!analysis || tab === 'pdf'} page={pdfPage} getPdf={getPdf} />
        </section>
      )}
    </article>
  );
}

function RunBanners({ run, busy, onResumeUpload, onResumeExtract, onAnswer }: Omit<Props, 'job' | 'getPdf' | 'onDelete'>) {
  if (run.status === 'uploading')
    return (
      <div className="alert warn">
        <Icon name="warn" />
        <span>
          Upload interrupted after {run.uploadedChunks.length} of {run.chunkCount} chunks. Choose the same file to continue where it
          stopped; stored chunks are not sent again.
        </span>
        <label className={`button${busy ? ' disabled' : ''}`}>
          Choose file
          <input
            type="file"
            accept="application/pdf,.pdf"
            hidden
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) onResumeUpload(f);
            }}
          />
        </label>
      </div>
    );
  if (run.status === 'awaiting_text')
    return (
      <div className="alert warn">
        <Icon name="warn" />
        <span>The PDF is stored, but reading it never finished (the tab was probably closed).</span>
        <button disabled={busy} onClick={onResumeExtract}>Resume</button>
      </div>
    );
  if (run.status === 'failed')
    return (
      <div className="alert error" role="alert">
        <Icon name="bad" />
        <span>Analysis failed: {run.error ?? 'unknown error'}</span>
        {run.pages.length > 0 && <button disabled={busy} onClick={() => onAnswer({})}>Retry analysis</button>}
      </div>
    );
  return null;
}

function downloadJson(data: unknown, name: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Verdict({ result }: { result: RateResult }) {
  const total = totalBrokerage(result);
  return (
    <section className={`card verdict ${result.status}`} aria-labelledby="verdict-title">
      <div className="verdict-head">
        <Badge value={result.status} />
        <h2 id="verdict-title">{verdictHeadline(result)}</h2>
        <p>{result.summary}</p>
      </div>
      <div className="tiles">
        <RateTile label="Own damage (OD)" c={result.od} />
        <RateTile label="Third party (TP)" c={result.tp} />
      </div>
      <footer className="verdict-foot">
        {total != null && (
          <div className="total">
            <span className="muted">Expected brokerage</span>
            <strong>{fmtRupees(total)}</strong>
          </div>
        )}
        <Confidence level={result.confidence.level} reason={result.confidence.reason} />
        {result.grid && (
          <div className="grid-src" title={result.grid.file}>
            <Icon name="grid" size={14} />
            <span>
              {result.grid.label}
              <span className="muted"> · effective {result.grid.effective}</span>
            </span>
          </div>
        )}
      </footer>
    </section>
  );
}

function RateTile({ label, c }: { label: string; c: RateComponent }) {
  const na = c.applicability === 'not_applicable';
  return (
    <div className={`tile ${c.applicability}`}>
      <div className="tile-head">
        <span>{label}</span>
        <Badge value={c.applicability} />
      </div>
      <div className="tile-rate">{na ? 'N/A' : rateDisplay(c)}</div>
      <div className="tile-applies">{na ? c.reason : `of ${c.appliesTo}`}</div>
      {!na && (c.premiumBase != null || c.expectedBrokerage != null) && (
        <dl className="tile-money">
          <div><dt>Premium base</dt><dd>{fmtRupees(c.premiumBase)}</dd></div>
          <div><dt>Brokerage</dt><dd><strong>{fmtRupees(c.expectedBrokerage)}</strong></dd></div>
        </dl>
      )}
      {c.candidates?.length ? (
        <ul className="candidates">
          {c.candidates.map((k, i) => (
            <li key={i}>
              <strong>{fmtRate(k.ratePercent)}</strong>
              <span>if {k.assumption}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {!na && <p className="tile-reason">{c.reason}</p>}
      {c.citations.length > 0 && (
        <details className="cells">
          <summary>
            <Icon name="chevron" size={14} /> {c.citations.length} grid {c.citations.length === 1 ? 'cell' : 'cells'} cited
          </summary>
          <Citations items={c.citations} limit={12} />
        </details>
      )}
    </div>
  );
}

function Confidence({ level, reason }: { level: 'high' | 'medium' | 'low'; reason: string }) {
  const n = { low: 1, medium: 2, high: 3 }[level];
  return (
    <div className={`confidence ${level}`} title={reason}>
      <span className="meter" aria-hidden="true">
        {[1, 2, 3].map((i) => <span key={i} className={i <= n ? 'on' : ''} />)}
      </span>
      <span>
        <strong>{level[0].toUpperCase() + level.slice(1)} confidence</strong>
        <span className="muted"> · {reason}</span>
      </span>
    </div>
  );
}

function Questions({ questions, busy, onAnswer }: { questions: ClarifyingQuestion[]; busy: boolean; onAnswer: Props['onAnswer'] }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const set = (fact: string, v: string) => setValues((cur) => ({ ...cur, [fact]: v }));
  const ready = Object.values(values).some((v) => v.trim());
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const overrides: FactOverrides = {};
    for (const q of questions) {
      const v = values[q.fact]?.trim();
      if (!v) continue;
      // Free-text numbers go as numbers; option values are passed through as the engine defined them.
      overrides[q.fact] = !q.options && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
    }
    if (Object.keys(overrides).length) onAnswer(overrides);
  };
  return (
    <section className="card questions" aria-labelledby="questions-title">
      <div className="q-head">
        <span className="q-icon" aria-hidden="true"><Icon name="question" size={20} /></span>
        <div>
          <h2 id="questions-title">Needs your input</h2>
          <p className="muted">
            The policy alone doesn't settle the rate, so the agent asks instead of guessing. Answers are saved as facts set by you, and
            the trace shows them next to what the document said.
          </p>
        </div>
      </div>
      <form onSubmit={submit}>
        {questions.map((q) => (
          <fieldset key={q.fact} className="question">
            <legend>{q.question}</legend>
            {q.options?.length ? (
              <div className="options" role="radiogroup">
                {q.options.map((o) => (
                  <label key={o.value} className={`option${values[q.fact] === o.value ? ' selected' : ''}`}>
                    <input type="radio" name={q.fact} value={o.value} checked={values[q.fact] === o.value} onChange={() => set(q.fact, o.value)} />
                    {o.label}
                  </label>
                ))}
              </div>
            ) : (
              <input className="text-input" value={values[q.fact] ?? ''} onChange={(e) => set(q.fact, e.target.value)} placeholder="Your answer" />
            )}
          </fieldset>
        ))}
        <div className="form-actions">
          <button type="submit" className="primary" disabled={busy || !ready}>Re-analyse with my answers</button>
          {questions.length > 1 && <span className="muted">Answer what you know; the rest stays open.</span>}
        </div>
      </form>
    </section>
  );
}

function Snapshot({ facts, onShowAll }: { facts: PolicyFacts; onShowAll: () => void }) {
  const join = (...parts: unknown[]) => parts.filter((p) => p != null && p !== '').join(' · ') || null;
  const items: { label: string; value: string | null; facts: Fact<unknown>[] }[] = [
    { label: 'Business', value: facts.businessType.value && facts.businessType.value[0].toUpperCase() + facts.businessType.value.slice(1), facts: [facts.businessType] },
    { label: 'Previous insurer', value: facts.previousInsurer.value, facts: [facts.previousInsurer] },
    { label: 'Vehicle', value: join(facts.make.value, facts.model.value), facts: [facts.make, facts.model] },
    {
      label: 'Fuel · engine',
      value: join(
        facts.fuel.value ? facts.fuel.value.toUpperCase() + (facts.cngLpgKit.value ? ' + kit' : '') : 'Fuel not printed',
        facts.cc.value != null && `${facts.cc.value} cc`,
      ),
      facts: [facts.fuel, facts.cc],
    },
    { label: 'RTO', value: join(facts.rtoCode.value, facts.rtoLocation.value), facts: [facts.rtoCode, facts.rtoLocation] },
    {
      label: 'Registered',
      value: join(facts.registrationDate.value && fmtDay(facts.registrationDate.value), facts.vehicleAgeYears.value != null && `${facts.vehicleAgeYears.value} yr old`),
      facts: [facts.registrationDate, facts.vehicleAgeYears],
    },
    { label: 'NCB', value: facts.ncbPercent.value != null ? `${facts.ncbPercent.value}%` : null, facts: [facts.ncbPercent] },
    {
      label: 'Policy period',
      value: facts.policyStart.value ? `${fmtDay(facts.policyStart.value)} → ${facts.policyEnd.value ? fmtDay(facts.policyEnd.value) : '?'}` : null,
      facts: [facts.policyStart],
    },
  ];
  return (
    <section className="card snapshot" aria-labelledby="snapshot-title">
      <div className="section-head">
        <h2 id="snapshot-title">Policy at a glance</h2>
        <button className="link" onClick={onShowAll}>All facts and evidence</button>
      </div>
      <dl>
        {items.map((it) => {
          // Flag the fact behind the shown value first (a derived age), and only fall back to a missing companion fact.
          const flagged = it.facts.find((f) => f.status !== 'found' && f.value != null) ?? it.facts.find((f) => f.status !== 'found');
          return (
            <div key={it.label}>
              <dt>{it.label}</dt>
              <dd className={it.value ? '' : 'muted'}>
                {it.value ?? 'Not in policy'}
                {flagged && it.value && <span className={`flag ${flagged.status}`} title={STATUS_HINT[flagged.status]}>{flagged.status === 'user' ? 'set by you' : flagged.status}</span>}
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

function Tabs<T extends string>({ tab, onTab, items }: { tab: T; onTab: (t: T) => void; items: { id: T; label: string; short: string; count?: number; countTone?: string }[] }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    const next = (i + d + items.length) % items.length;
    onTab(items[next].id);
    refs.current[next]?.focus();
  };
  return (
    <div className="tabs" role="tablist">
      {items.map((it, i) => (
        <button
          key={it.id}
          ref={(el) => void (refs.current[i] = el)}
          role="tab"
          aria-selected={tab === it.id}
          tabIndex={tab === it.id ? 0 : -1}
          className={tab === it.id ? 'active' : ''}
          onClick={() => onTab(it.id)}
          onKeyDown={(e) => onKey(e, i)}
        >
          <span className="hide-sm">{it.label}</span>
          <span className="show-sm">{it.short}</span>
          {it.count ? <span className={`count ${it.countTone ?? ''}`}>{it.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

function Trace({ result }: { result: RateResult }) {
  return (
    <ol className="timeline" role="tabpanel">
      {result.trace.map((s, i) => {
        const outcome = s.outcome ?? 'ok';
        return (
          <li key={i} className={`t-step ${outcome}`}>
            <span className="t-marker" aria-label={outcome}>
              <Icon name={outcome === 'stop' ? 'stop' : outcome === 'warn' ? 'warn' : 'ok'} size={13} />
            </span>
            <div className="t-body">
              <strong>{s.title}</strong>
              <p>{s.detail}</p>
              <Citations items={s.citations} />
            </div>
          </li>
        );
      })}
    </ol>
  );
}

type FactFilter = 'all' | 'attention' | 'user';

function Facts({ analysis, editable, onAnswer, onPage }: { analysis: AnalysisResult; editable: boolean; onAnswer: Props['onAnswer']; onPage: (page: number) => void }) {
  const rows = factRowsOf(analysis.facts);
  const [filter, setFilter] = useState<FactFilter>('all');
  const [editing, setEditing] = useState<FactKey | null>(null);
  const counts = {
    all: rows.length,
    attention: rows.filter(([, f]) => needsAttention(f.status)).length,
    user: rows.filter(([, f]) => f.status === 'user').length,
  };
  const shown = rows.filter(([, f]) => (filter === 'attention' ? needsAttention(f.status) : filter === 'user' ? f.status === 'user' : true));
  return (
    <div role="tabpanel" className="facts-panel">
      <div className="facts-bar">
        <div className="segmented" role="group" aria-label="Filter facts">
          {([['all', 'All'], ['attention', 'Missing or unclear'], ['user', 'Set by you']] as const).map(([id, label]) => (
            <button key={id} className={filter === id ? 'active' : ''} aria-pressed={filter === id} onClick={() => setFilter(id)}>
              {label} <span className="muted">{counts[id]}</span>
            </button>
          ))}
        </div>
        {editable && <span className="muted hint">Spotted a misread? Correct it and the rate is recomputed, with your change kept in the trace.</span>}
      </div>
      {shown.length === 0 ? (
        <p className="empty-note">{filter === 'user' ? 'You have not corrected or answered anything yet.' : 'Every fact was read cleanly.'}</p>
      ) : (
        <table className="facts">
          <thead>
            <tr><th>Fact</th><th>Value</th><th>Status</th><th>Evidence</th><th><span className="visually-hidden">Actions</span></th></tr>
          </thead>
          <tbody>
            {shown.map(([key, f]) =>
              editing === key ? (
                <EditRow key={key} factKey={key} fact={f} onCancel={() => setEditing(null)} onSave={(v) => (setEditing(null), onAnswer({ [key]: v }))} />
              ) : (
                <tr key={key} className={needsAttention(f.status) ? 'attention' : ''}>
                  <th scope="row">{FACT_LABELS[key] ?? key}</th>
                  <td className="value">
                    {fmtValue(f.value, key)}
                    {f.candidates?.length ? <div className="muted small">could be {f.candidates.map((c) => fmtValue(c, key)).join(' or ')}</div> : null}
                  </td>
                  <td><Badge value={f.status} title={STATUS_HINT[f.status]} /></td>
                  <td className="evidence">
                    {f.evidence.map((e, i) => (
                      <div key={i} className="ev">
                        {e.page != null && (
                          <button className="chip page" onClick={() => onPage(e.page!)} title={`Open page ${e.page} of the policy`}>
                            p.{e.page}
                          </button>
                        )}
                        <q>{e.quote}</q>
                        {e.source !== 'text-layer' && <span className="src">{e.source === 'ocr' ? 'OCR' : e.source}</span>}
                      </div>
                    ))}
                    {f.note && <div className="muted small">{f.note}</div>}
                  </td>
                  <td className="actions">
                    {editable && FACT_INPUTS[key] && (
                      <button className="icon-button" onClick={() => setEditing(key)} aria-label={`Correct ${FACT_LABELS[key]}`} title="Correct this fact">
                        <Icon name="edit" size={15} />
                      </button>
                    )}
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}

function EditRow({ factKey, fact, onSave, onCancel }: { factKey: FactKey; fact: Fact<unknown>; onSave: (v: string) => void; onCancel: () => void }) {
  const input = FACT_INPUTS[factKey]!;
  const [value, setValue] = useState(toInputValue(fact.value, input));
  const submit = (e: FormEvent) => (e.preventDefault(), value.trim() && onSave(value.trim()));
  const common = { autoFocus: true, value, 'aria-label': FACT_LABELS[factKey], onKeyDown: (e: KeyboardEvent) => e.key === 'Escape' && onCancel() };
  return (
    <tr className="editing">
      <th scope="row">{FACT_LABELS[factKey]}</th>
      <td colSpan={4}>
        <form className="edit-form" onSubmit={submit}>
          {input.kind === 'select' ? (
            <select {...common} onChange={(e) => setValue(e.target.value)}>
              <option value="">Choose…</option>
              {input.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          ) : (
            <input
              {...common}
              className="text-input"
              type={input.kind === 'date' ? 'date' : 'text'}
              inputMode={input.kind === 'number' ? 'decimal' : undefined}
              onChange={(e) => setValue(e.target.value)}
              placeholder={factKey === 'covers' ? 'Comma-separated, e.g. Nil Dep, RTI' : undefined}
            />
          )}
          <button type="submit" className="primary" disabled={!value.trim()}>Save and re-analyse</button>
          <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
        </form>
      </td>
    </tr>
  );
}

/** Loads the PDF the first time its tab opens and keeps it, so switching tabs doesn't download it again. */
function PdfPanel({ active, page, getPdf }: { active: boolean; page?: number; getPdf: () => Promise<Blob> }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (!active || started.current) return;
    started.current = true;
    getPdf().then(
      (b) => setUrl(URL.createObjectURL(b)),
      (e: Error) => setError(e.message),
    );
  }, [active, getPdf]);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  return (
    <div role="tabpanel" className="pdf-panel" hidden={!active}>
      {error ? (
        <div className="alert error"><Icon name="bad" /><span>Could not load the PDF: {error}</span></div>
      ) : !url ? (
        <div className="pdf-loading"><span className="spinner" aria-hidden="true" /> Loading the stored PDF…</div>
      ) : (
        <>
          <div className="pdf-bar">
            <span className="muted">{page ? `Showing page ${page}` : 'Original upload, reassembled from stored chunks'}</span>
            <a className="button ghost" href={url} target="_blank" rel="noreferrer">
              <Icon name="external" size={14} /> Open in new tab
            </a>
          </div>
          <iframe key={page ?? 0} className="pdf" src={page ? `${url}#page=${page}` : url} title="Original policy PDF" />
        </>
      )}
    </div>
  );
}
