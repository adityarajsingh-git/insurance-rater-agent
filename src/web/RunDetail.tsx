import { useEffect, useState, type FormEvent } from 'react';
import type { AnalysisResult, ClarifyingQuestion, Fact, FactKey, FactOverrides, RateComponent } from '../core/types';
import type { RunRecord } from '../server/runs';
import { Badge, Citations, fmtDate, fmtRate, fmtRupees } from './ui';

const FACT_LABELS: Record<FactKey, string> = {
  insurerName: 'Insurer name', insurer: 'Insurer', policyType: 'Policy type', businessType: 'Business type',
  previousInsurer: 'Previous insurer', make: 'Make', model: 'Model', fuel: 'Fuel', cngLpgKit: 'CNG/LPG kit',
  cc: 'Engine cc', seats: 'Seats', manufactureYear: 'Manufacture year', registrationDate: 'Registration date',
  vehicleAgeYears: 'Vehicle age (years)', registrationNumber: 'Registration number', rtoCode: 'RTO code',
  rtoLocation: 'RTO location', state: 'State', ncbPercent: 'NCB %', covers: 'Add-on covers', gwpSlab: 'GWP slab (broker)', policyStart: 'Policy start', policyEnd: 'Policy end',
  'premium.netOd': 'Net OD premium', 'premium.netTp': 'Net TP premium', 'premium.netPremium': 'Net premium',
  'premium.gst': 'GST', 'premium.total': 'Total payable',
};

const fmtValue = (v: unknown, key: string) =>
  v == null ? '—' : Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : key.startsWith('premium.') && typeof v === 'number' ? fmtRupees(v) : String(v);

interface Props {
  run: RunRecord;
  busy: boolean;
  onResumeUpload: (file: File) => void;
  onResumeExtract: () => void;
  onAnswer: (overrides: FactOverrides) => void;
  getPdf: () => Promise<Blob>;
}

export function RunDetail({ run, busy, onResumeUpload, onResumeExtract, onAnswer, getPdf }: Props) {
  const [rev, setRev] = useState(run.analyses.length - 1);
  useEffect(() => setRev(run.analyses.length - 1), [run.analyses.length]); // jump to a new revision when it lands
  const analysis = run.analyses[rev];
  const ocrPages = run.pages.filter((p) => p.source === 'ocr').length;

  return (
    <article className="detail">
      <div className="detail-head">
        <div>
          <h2>{run.fileName}</h2>
          <div className="muted">
            {fmtDate(run.createdAt)} · {(run.fileSize / 1024 / 1024).toFixed(1)} MB
            {run.pages.length > 0 && ` · ${run.pages.length} pages (${ocrPages} OCR)`}
          </div>
        </div>
        <Badge value={run.status} />
      </div>

      {run.status === 'uploading' && (
        <div className="alert warn">
          Upload interrupted: {run.uploadedChunks.length}/{run.chunkCount} chunks stored. Select the same file to resume.{' '}
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
      )}
      {run.status === 'awaiting_text' && (
        <div className="alert warn">
          The PDF is stored but its text was never analysed (the tab was probably closed).{' '}
          <button disabled={busy} onClick={onResumeExtract}>Resume</button>
        </div>
      )}
      {run.status === 'failed' && (
        <div className="alert error">
          Analysis failed: {run.error ?? 'unknown error'}{' '}
          {run.pages.length > 0 && <button disabled={busy} onClick={() => onAnswer({})}>Retry analysis</button>}
        </div>
      )}

      {run.status !== 'uploading' && <PdfViewer getPdf={getPdf} />}

      {analysis && (
        <>
          <div className="toolbar">
            {run.analyses.length > 1 && (
              <label>
                Revision{' '}
                <select value={rev} onChange={(e) => setRev(Number(e.target.value))}>
                  {run.analyses.map((a, i) => (
                    <option key={i} value={i}>
                      {i + 1} of {run.analyses.length} · {fmtDate(a.analysedAt)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <span className="muted">Engine {analysis.engineVersion}</span>
            <button onClick={() => downloadJson(analysis, `${run.fileName.replace(/\.pdf$/i, '')}-analysis-r${rev + 1}.json`)}>
              Download JSON
            </button>
          </div>
          <Analysis analysis={analysis} busy={busy} onAnswer={onAnswer} latest={rev === run.analyses.length - 1} />
        </>
      )}
    </article>
  );
}

function downloadJson(data: unknown, name: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function PdfViewer({ getPdf }: { getPdf: () => Promise<Blob> }) {
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [error, setError] = useState('');
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);

  if (url)
    return (
      <section className="card">
        <div className="card-head">
          <h3>Original PDF</h3>
          <a href={url} target="_blank" rel="noreferrer">Open in new tab</a>
        </div>
        <iframe className="pdf" src={url} title="Original policy PDF" />
      </section>
    );
  return (
    <div className="toolbar">
      <button
        disabled={state === 'loading'}
        onClick={() => {
          setState('loading');
          getPdf().then(
            (b) => setUrl(URL.createObjectURL(b)),
            (e: Error) => (setState('error'), setError(e.message)),
          );
        }}
      >
        {state === 'loading' ? 'Loading PDF…' : 'View original PDF'}
      </button>
      {state === 'error' && <span className="error-text">Could not load the PDF: {error}</span>}
    </div>
  );
}

function Analysis({ analysis, busy, onAnswer, latest }: { analysis: AnalysisResult; busy: boolean; onAnswer: Props['onAnswer']; latest: boolean }) {
  const { result, facts } = analysis;
  const factRows: [FactKey, Fact<unknown>][] = [
    ...(Object.entries(facts).filter(([k]) => k !== 'premium') as [FactKey, Fact<unknown>][]),
    ...(Object.entries(facts.premium).map(([k, f]) => [`premium.${k}`, f]) as [FactKey, Fact<unknown>][]),
  ];
  return (
    <>
      <section className="card result-head">
        <div className="row">
          <Badge value={result.status} />
          <span>
            Confidence <Badge value={result.confidence.level} /> <span className="muted">{result.confidence.reason}</span>
          </span>
        </div>
        <p className="summary">{result.summary}</p>
        {result.grid && (
          <p className="muted" title={result.grid.file}>
            Grid: {result.grid.label} (effective {result.grid.effective})
          </p>
        )}
      </section>

      <div className="rates">
        <RateCard title="Own Damage (OD)" c={result.od} />
        <RateCard title="Third Party (TP)" c={result.tp} />
      </div>

      {result.questions.length > 0 && latest && <Questions questions={result.questions} busy={busy} onAnswer={onAnswer} />}

      <section className="card">
        <h3>Decision trace</h3>
        <ol className="trace">
          {result.trace.map((s, i) => (
            <li key={i} className={`step ${s.outcome ?? 'ok'}`}>
              <span className="icon" aria-label={s.outcome ?? 'ok'}>{s.outcome === 'stop' ? '✕' : s.outcome === 'warn' ? '!' : '✓'}</span>
              <div>
                <strong>{s.title}</strong>
                <div>{s.detail}</div>
                <Citations items={s.citations} />
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="card">
        <h3>Extracted facts</h3>
        <table className="facts">
          <thead>
            <tr><th>Fact</th><th>Value</th><th>Status</th><th>Evidence</th></tr>
          </thead>
          <tbody>
            {factRows.map(([key, f]) => (
              <tr key={key}>
                <td>{FACT_LABELS[key] ?? key}</td>
                <td>
                  {fmtValue(f.value, key)}
                  {f.candidates?.length ? <div className="muted">candidates: {f.candidates.map((c) => fmtValue(c, key)).join(', ')}</div> : null}
                </td>
                <td><Badge value={f.status} /></td>
                <td>
                  {f.evidence.map((e, i) => (
                    <div key={i} className="evidence">
                      {e.page != null && <span className="chip">p.{e.page}</span>} <q>{e.quote}</q>{' '}
                      <span className="muted">({e.source})</span>
                    </div>
                  ))}
                  {f.note && <div className="muted">{f.note}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

function RateCard({ title, c }: { title: string; c: RateComponent }) {
  return (
    <section className="card rate">
      <div className="card-head">
        <h3>{title}</h3>
        <Badge value={c.applicability} />
      </div>
      <div className="rate-value">{fmtRate(c.ratePercent)}</div>
      <div className="muted">applies to {c.appliesTo}</div>
      {(c.premiumBase != null || c.expectedBrokerage != null) && (
        <dl className="kv">
          <dt>Premium base</dt><dd>{fmtRupees(c.premiumBase)}</dd>
          <dt>Expected brokerage</dt><dd>{fmtRupees(c.expectedBrokerage)}</dd>
        </dl>
      )}
      <p>{c.reason}</p>
      <Citations items={c.citations} />
      {c.candidates?.length ? (
        <div className="candidates">
          <div className="muted">Candidate rates</div>
          <ul>
            {c.candidates.map((k, i) => (
              <li key={i}>
                <strong>{fmtRate(k.ratePercent)}</strong> if {k.assumption} <Citations items={k.citations} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function Questions({ questions, busy, onAnswer }: { questions: ClarifyingQuestion[]; busy: boolean; onAnswer: Props['onAnswer'] }) {
  const [values, setValues] = useState<Record<string, string>>({});
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
    <section className="card questions">
      <h3>Clarifying questions</h3>
      <form onSubmit={submit}>
        {questions.map((q) => (
          <label key={q.fact} className="question">
            <span>{q.question}</span>
            {q.options?.length ? (
              <select value={values[q.fact] ?? ''} onChange={(e) => setValues({ ...values, [q.fact]: e.target.value })}>
                <option value="">Choose…</option>
                {q.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            ) : (
              <input value={values[q.fact] ?? ''} onChange={(e) => setValues({ ...values, [q.fact]: e.target.value })} />
            )}
          </label>
        ))}
        <button type="submit" disabled={busy || !Object.values(values).some((v) => v.trim())}>Re-analyse with answers</button>
      </form>
    </section>
  );
}
