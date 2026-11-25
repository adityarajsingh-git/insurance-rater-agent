import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { RunRecord, RunSummary } from '../server/runs';
import { api, downloadPdf, extractPages, sha256Hex, uploadMissingChunks } from './lib';
import { RunDetail } from './RunDetail';
import { Badge, fmtDate, fmtRate } from './ui';
import './styles.css';

type Job = { runId?: string; label: string; progress?: number };

const hashId = () => decodeURIComponent(location.hash.slice(1));

function App() {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState(hashId);
  const [run, setRun] = useState<RunRecord | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const localPdfs = useRef(new Map<string, Blob>()); // files picked in this tab, so viewing them needs no download
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;

  const refreshList = useCallback(() => {
    api.list().then(
      (r) => (setRuns(r), setListError(null)),
      (e: Error) => setListError(e.message),
    );
  }, []);

  useEffect(() => {
    refreshList();
    const onHash = () => setSelectedId(hashId());
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
  };
  /** Shows a server update if its run is still on screen. */
  const show = (r: RunRecord) => {
    if (selectedRef.current === r.id) setRun(r);
  };

  async function runJob(runId: string | undefined, fn: () => Promise<void>) {
    setJobError(null);
    setJob({ runId, label: 'Starting…' });
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
    const pages = await extractPages(pdf, (p) =>
      setJob({
        runId: r.id,
        label:
          p.mode === 'ocr'
            ? `OCR page ${p.page}/${p.pages} (${Math.round((p.ocr ?? 0) * 100)}%)`
            : `Reading text layer, page ${p.page}/${p.pages}`,
        progress: (p.page - 1 + (p.mode === 'ocr' ? (p.ocr ?? 0) : 1)) / p.pages,
      }),
    );
    setJob({ runId: r.id, label: 'Analysing…' });
    show(await api.pages(r.id, pages));
  }

  /** New upload, or resuming an interrupted one when `resume` is given (the file must be byte-identical). */
  function processFile(file: File, resume?: RunRecord) {
    if (!/\.pdf$/i.test(file.name)) return setJobError('Please choose a PDF file.');
    void runJob(resume?.id, async () => {
      setJob({ runId: resume?.id, label: 'Computing checksum…' });
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
          setJob({ runId: id, label: `Uploading chunk ${done}/${total}`, progress: done / total }),
        );
        show(r);
      }
      await extractAndAnalyse(r, file);
    });
  }

  /** Re-runs text extraction for an `awaiting_text` run from the chunks stored on the server. */
  function resumeFromServer(r: RunRecord) {
    void runJob(r.id, async () => {
      const pdf =
        localPdfs.current.get(r.id) ??
        (await downloadPdf(r, (d, t) => setJob({ runId: r.id, label: `Downloading chunk ${d}/${t}`, progress: d / t })));
      localPdfs.current.set(r.id, pdf);
      await extractAndAnalyse(r, pdf);
    });
  }

  function answer(r: RunRecord, overrides: Parameters<typeof api.answers>[1]) {
    void runJob(r.id, async () => {
      setJob({ runId: r.id, label: 'Re-analysing with your answers…' });
      show(await api.answers(r.id, overrides));
    });
  }

  async function getPdf(r: RunRecord) {
    const cached = localPdfs.current.get(r.id);
    if (cached) return cached;
    const pdf = await downloadPdf(r);
    localPdfs.current.set(r.id, pdf);
    return pdf;
  }

  const busy = job !== null;
  return (
    <div className="app">
      <header className="topbar">
        <h1>Insurance Rater Agent</h1>
        <span className="muted">Motor policy PDF in, broker commission OD/TP rates out, with citations</span>
      </header>
      <aside className="sidebar">
        <label
          className={`dropzone${dragging ? ' dragging' : ''}${busy ? ' disabled' : ''}`}
          onDragOver={(e) => (e.preventDefault(), setDragging(true))}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const f = e.dataTransfer.files[0];
            if (f && !busy) processFile(f);
          }}
        >
          <input
            type="file"
            accept="application/pdf,.pdf"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) processFile(f);
            }}
          />
          <strong>Drop a policy PDF</strong>
          <span className="muted">or click to choose a file</span>
        </label>
        {job && (
          <div className="job">
            <div>{job.label}</div>
            {job.progress !== undefined && <progress value={job.progress} max={1} />}
          </div>
        )}
        {jobError && (
          <div className="alert error" role="alert">
            {jobError} <button className="link" onClick={() => setJobError(null)}>Dismiss</button>
          </div>
        )}
        <h2 className="section-title">History</h2>
        {listError && <div className="alert error">Could not load history: {listError}</div>}
        {runs?.length === 0 && <p className="muted">No runs yet.</p>}
        <ul className="history">
          {runs?.map((s) => (
            <li key={s.id}>
              <button className={s.id === selectedId ? 'active' : ''} onClick={() => select(s.id)}>
                <span className="file" title={s.fileName}>{s.fileName}</span>
                <span className="row">
                  <span className="muted">{fmtDate(s.createdAt)}</span>
                  <Badge value={s.resultStatus ?? s.status} />
                </span>
                <span className="row muted">
                  <span>{s.insurer ?? '—'}{s.policyType ? ` · ${s.policyType.toUpperCase()}` : ''}</span>
                  <span>OD {fmtRate(s.odRate)} · TP {fmtRate(s.tpRate)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <main className="main">
        {!selectedId && <div className="empty">Upload a motor policy PDF or pick a run from the history.</div>}
        {runError && <div className="alert error">Could not load run: {runError}</div>}
        {selectedId && !run && !runError && <div className="muted">Loading…</div>}
        {run && (
          <RunDetail
            key={run.id}
            run={run}
            busy={busy}
            onResumeUpload={(f) => processFile(f, run)}
            onResumeExtract={() => resumeFromServer(run)}
            onAnswer={(o) => answer(run, o)}
            getPdf={() => getPdf(run)}
          />
        )}
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
