import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { InsurerId } from '../core/types';
import type { RunRecord, RunSummary } from '../server/runs';
import { INSURERS, fmtRate, insurerName, matchesQuery, policyTypeLabel, relTime } from './format';
import { api, downloadPdf, extractPages, sha256Hex, uploadMissingChunks } from './lib';
import { Progress, type Job } from './Progress';
import { RunDetail } from './RunDetail';
import { Icon, toneOf } from './ui';
import './styles.css';

const hashId = () => decodeURIComponent(location.hash.slice(1));
const isPdf = (f: File) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf';

function App() {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState(hashId);
  const [run, setRun] = useState<RunRecord | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const localPdfs = useRef(new Map<string, Blob>()); // files picked in this tab, so viewing them needs no download
  const fileInput = useRef<HTMLInputElement>(null);
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const busy = job !== null;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  const refreshList = useCallback(() => {
    api.list().then(
      (r) => (setRuns(r), setListError(null)),
      (e: Error) => setListError(e.message),
    );
  }, []);

  useEffect(() => {
    refreshList();
    const onHash = () => (setSelectedId(hashId()), setDrawer(false));
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, [refreshList]);

  useEffect(() => {
    setRun(null);
    setRunError(null);
    if (!selectedId) return;
    api.get(selectedId).then(
      (r) => selectedRef.current === r.id && setRun(r),
      (e: Error) => setRunError(e.message),
    );
  }, [selectedId]);

  const select = (id: string) => {
    location.hash = id;
    setDrawer(false); // picking the run already on screen fires no hashchange
  };

  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && setDrawer(false);
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [drawer]);
  /** Shows a server update if its run is still on screen. */
  const show = (r: RunRecord) => {
    if (selectedRef.current === r.id) setRun(r);
  };

  async function runJob(first: Job, fn: () => Promise<void>) {
    setJobError(null);
    setJob(first);
    try {
      await fn();
    } catch (e) {
      setJobError((e as Error).message);
    } finally {
      setJob(null);
      refreshList();
    }
  }

  async function extractAndAnalyse(r: RunRecord, pdf: Blob) {
    const base = { runId: r.id, fileName: r.fileName };
    const pages = await extractPages(pdf, (p) =>
      setJob({
        ...base,
        step: 'read',
        label: p.mode === 'ocr' ? `OCR page ${p.page} of ${p.pages}` : `Reading text, page ${p.page} of ${p.pages}`,
        progress: (p.page - 1 + (p.mode === 'ocr' ? (p.ocr ?? 0) : 1)) / p.pages,
      }),
    );
    setJob({ ...base, step: 'analyse', label: 'Matching the policy against the grid…' });
    show(await api.pages(r.id, pages));
  }

  /** New upload, or resuming an interrupted one when `resume` is given (the file must be byte-identical). */
  function processFile(getFile: () => Promise<File>, fileName: string, resume?: RunRecord) {
    void runJob({ runId: resume?.id, fileName, step: 'upload', label: 'Preparing the file…' }, async () => {
      const file = await getFile();
      if (!isPdf(file)) throw new Error(`${file.name} is not a PDF. Upload the policy schedule as a PDF.`);
      setJob({ runId: resume?.id, fileName, step: 'upload', label: 'Computing checksum…' });
      const sha = await sha256Hex(await file.arrayBuffer());
      let r = resume;
      if (r) {
        if (sha !== r.sha256) throw new Error(`${file.name} is not the file this run was started with (checksum differs).`);
      } else {
        r = await api.create(file, sha);
        select(r.id);
        refreshList();
      }
      localPdfs.current.set(r.id, file);
      const id = r.id;
      if (r.status === 'uploading') {
        r = await uploadMissingChunks(r, file, (done, total) =>
          setJob({ runId: id, fileName, step: 'upload', label: `Uploading chunk ${done} of ${total}`, progress: done / total }),
        );
        show(r);
      }
      await extractAndAnalyse(r, file);
    });
  }

  const uploadFile = (file: File, resume?: RunRecord) => {
    if (busyRef.current) return;
    if (!isPdf(file)) return setJobError(`${file.name} is not a PDF. Upload the policy schedule as a PDF.`);
    processFile(async () => file, file.name, resume);
  };

  const trySample = (name: string) =>
    processFile(
      async () => {
        const res = await fetch(`/${name}`);
        if (!res.ok) throw new Error(`Could not fetch the sample (${res.status}).`);
        return new File([await res.blob()], name, { type: 'application/pdf' });
      },
      name,
    );

  /** Re-runs text extraction for an `awaiting_text` run from the chunks stored on the server. */
  function resumeFromServer(r: RunRecord) {
    void runJob({ runId: r.id, fileName: r.fileName, step: 'read', label: 'Fetching the stored PDF…' }, async () => {
      const pdf =
        localPdfs.current.get(r.id) ??
        (await downloadPdf(r, (d, t) =>
          setJob({ runId: r.id, fileName: r.fileName, step: 'read', label: `Fetching stored chunk ${d} of ${t}`, progress: d / t }),
        ));
      localPdfs.current.set(r.id, pdf);
      await extractAndAnalyse(r, pdf);
    });
  }

  function answer(r: RunRecord, overrides: Parameters<typeof api.answers>[1]) {
    void runJob({ runId: r.id, fileName: r.fileName, step: 'analyse', label: 'Re-analysing with your answers…' }, async () => {
      show(await api.answers(r.id, overrides));
    });
  }

  /** Deletes a run (record and stored PDF chunks) after a confirmation, then returns to the start screen. */
  async function removeRun(r: RunRecord) {
    if (!confirm(`Delete "${r.fileName}"?\n\nThe analysis, every revision and the stored PDF are removed for everyone. This cannot be undone.`)) return;
    setJobError(null);
    try {
      await api.remove(r.id);
      localPdfs.current.delete(r.id);
      if (selectedRef.current === r.id) location.hash = '';
      refreshList();
    } catch (e) {
      setJobError(`Could not delete: ${(e as Error).message}`);
    }
  }

  async function getPdf(r: RunRecord) {
    const cached = localPdfs.current.get(r.id);
    if (cached) return cached;
    const pdf = await downloadPdf(r);
    localPdfs.current.set(r.id, pdf);
    return pdf;
  }

  // Drop a PDF anywhere on the page. The depth counter ignores dragenter/leave from child elements.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      setDragging(true);
    };
    const over = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const f = e.dataTransfer?.files[0];
      if (f) uploadFile(f);
    };
    addEventListener('dragenter', enter);
    addEventListener('dragover', over);
    addEventListener('dragleave', leave);
    addEventListener('drop', drop);
    return () => {
      removeEventListener('dragenter', enter);
      removeEventListener('dragover', over);
      removeEventListener('dragleave', leave);
      removeEventListener('drop', drop);
    };
  });

  const chooseFile = () => fileInput.current?.click();
  const visible = runs?.filter((s) => matchesQuery(s, query)) ?? null;
  const jobElsewhere = job && job.runId && job.runId !== selectedId ? job : null;

  return (
    <div className={`app${drawer ? ' drawer-open' : ''}`}>
      <input
        ref={fileInput}
        type="file"
        accept="application/pdf,.pdf"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) uploadFile(f);
        }}
      />
      <header className="topbar">
        <button className="icon-button drawer-toggle" onClick={() => setDrawer(!drawer)} aria-label="Show history" aria-expanded={drawer}>
          <Icon name="history" size={18} />
        </button>
        <a className="brand" href="#" aria-label="Insurance Rater Agent, home">
          <span className="brand-mark" aria-hidden="true">
            <Icon name="spark" size={16} />
          </span>
          <span className="brand-text">
            <strong>Insurance Rater Agent</strong>
            <span>Broker commission from a motor policy, with the grid cells to prove it</span>
          </span>
        </a>
        <button className="primary" onClick={chooseFile} disabled={busy}>
          <Icon name="plus" size={16} /> <span className="hide-sm">New analysis</span>
        </button>
      </header>

      <aside className="sidebar" aria-label="Analysis history">
        <div className="sidebar-head">
          <h2>History</h2>
          <span className="count">{runs?.length ?? ''}</span>
          <button className="icon-button drawer-close" onClick={() => setDrawer(false)} aria-label="Close history">
            <Icon name="close" size={16} />
          </button>
        </div>
        <label className="search">
          <Icon name="search" size={15} />
          <input type="search" placeholder="Search file, insurer, status" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search history" />
        </label>
        {jobElsewhere && (
          <button className="job-pill" onClick={() => select(jobElsewhere.runId!)}>
            <span className="spinner" aria-hidden="true" />
            <span>
              <strong>{jobElsewhere.fileName}</strong>
              <span>{jobElsewhere.label}</span>
            </span>
          </button>
        )}
        {listError && <div className="alert error small">Could not load history: {listError}</div>}
        {runs === null && !listError && <HistorySkeleton />}
        {runs?.length === 0 && <p className="sidebar-empty">No analyses yet. Your uploads will appear here.</p>}
        {visible && runs?.length !== 0 && visible.length === 0 && <p className="sidebar-empty">Nothing matches “{query}”.</p>}
        <ul className="history">
          {visible?.map((s) => {
            const state = s.resultStatus ?? s.status;
            return (
              <li key={s.id}>
                <button className={s.id === selectedId ? 'active' : ''} aria-current={s.id === selectedId ? 'true' : undefined} onClick={() => select(s.id)}>
                  <span className={`dot ${toneOf(state)}`} title={state.replace(/_/g, ' ')} />
                  <span className="h-body">
                    <span className="h-file" title={s.fileName}>{s.fileName}</span>
                    <span className="h-meta">
                      {[insurerName(s.insurer), policyTypeLabel(s.policyType)].filter(Boolean).join(' · ') || state.replace(/_/g, ' ')}
                      {' · '}
                      {relTime(s.createdAt)}
                    </span>
                  </span>
                  {(s.odRate != null || s.tpRate != null) && (
                    <span className="h-rates">
                      {s.odRate != null && <span>OD {fmtRate(s.odRate)}</span>}
                      {s.tpRate != null && <span>TP {fmtRate(s.tpRate)}</span>}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </aside>
      <div className="scrim" onClick={() => setDrawer(false)} aria-hidden="true" />

      <main className="main">
        {jobError && (
          <div className="alert error" role="alert">
            <Icon name="bad" />
            <span>{jobError}</span>
            <button className="link" onClick={() => setJobError(null)}>Dismiss</button>
          </div>
        )}
        {!selectedId && (
          job && !job.runId ? <Progress job={job} /> : <Home busy={busy} onChoose={chooseFile} onSample={trySample} />
        )}
        {runError && (
          <div className="alert error" role="alert">
            <Icon name="bad" />
            <span>Could not load this analysis: {runError}</span>
            <a className="link" href="#">Back to start</a>
          </div>
        )}
        {selectedId && !run && !runError && <DetailSkeleton />}
        {run && (
          <RunDetail
            key={run.id}
            run={run}
            job={job?.runId === run.id ? job : null}
            busy={busy}
            onResumeUpload={(f) => uploadFile(f, run)}
            onResumeExtract={() => resumeFromServer(run)}
            onAnswer={(o) => answer(run, o)}
            getPdf={() => getPdf(run)}
            onDelete={() => void removeRun(run)}
          />
        )}
      </main>

      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <div>
            <Icon name="upload" size={36} />
            <strong>Drop the policy PDF to analyse it</strong>
            <span>Text is read in your browser; scanned pages are OCR'd</span>
          </div>
        </div>
      )}
    </div>
  );
}

function Home({ busy, onChoose, onSample }: { busy: boolean; onChoose: () => void; onSample: (name: string) => void }) {
  return (
    <div className="home">
      <section className="hero">
        <h1>What will this policy earn the broker?</h1>
        <p>
          Upload a motor policy PDF. The agent reads it, finds the insurer's commission grid and returns the OD and TP rates, the
          expected brokerage in rupees and every grid cell behind them. When the policy doesn't say enough, it asks you instead
          of guessing.
        </p>
        <button className="dropcard" onClick={onChoose} disabled={busy}>
          <span className="drop-icon"><Icon name="upload" size={26} /></span>
          <strong>Drop a policy PDF here, or click to choose one</strong>
          <span className="muted">PDF up to 25 MB · text-layer and scanned policies both work</span>
        </button>
      </section>

      <section className="how">
        {[
          ['doc', 'Reads the policy', 'Insurer, policy type, vehicle, RTO, NCB and premiums, each with the page and line it came from.'],
          ['grid', 'Applies the right grid', "Each insurer's own workbook or rate card, including its footnotes, exclusions and declines."],
          ['question', 'Explains or asks', 'A cited decision trace when the rate is clear, a targeted question when it is not.'],
        ].map(([icon, title, text]) => (
          <div key={title} className="how-item">
            <span className="how-icon"><Icon name={icon} size={18} /></span>
            <div>
              <strong>{title}</strong>
              <p className="muted">{text}</p>
            </div>
          </div>
        ))}
      </section>

      <section>
        <div className="section-head">
          <h2>Supported insurers</h2>
          <span className="muted">Try one of the sample policies to see the full flow</span>
        </div>
        <div className="insurers">
          {(Object.keys(INSURERS) as InsurerId[]).map((id) => {
            const m = INSURERS[id];
            return (
              <div key={id} className="insurer-card">
                <div className="insurer-top">
                  <span className="avatar" aria-hidden="true">{m.name.slice(0, 2).toUpperCase()}</span>
                  <div>
                    <strong>{m.name}</strong>
                    <span className="muted">{m.gridKind}</span>
                  </div>
                </div>
                <dl className="insurer-meta">
                  <div><dt>Grid</dt><dd title={m.grid}>{m.grid}</dd></div>
                  <div><dt>Sample</dt><dd>{m.sampleLabel}</dd></div>
                </dl>
                <button onClick={() => onSample(m.sample)} disabled={busy} aria-label={`Try the ${m.name} sample policy`}>
                  <Icon name="spark" size={14} /> Try sample
                </button>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function HistorySkeleton() {
  return (
    <ul className="history" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <li key={i} className="skeleton-row"><span /><span /></li>
      ))}
    </ul>
  );
}

function DetailSkeleton() {
  return (
    <div className="detail" aria-busy="true" aria-label="Loading analysis">
      <div className="skeleton-block" style={{ height: 56 }} />
      <div className="skeleton-block" style={{ height: 220 }} />
      <div className="skeleton-block" style={{ height: 120 }} />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
