import { Icon } from './ui';

export type JobStep = 'upload' | 'read' | 'analyse';
export type Job = { runId?: string; fileName?: string; step: JobStep; label: string; progress?: number };

const STEPS: { id: JobStep; title: string; hint: string }[] = [
  { id: 'upload', title: 'Upload', hint: 'Checksummed and stored in 2.5 MB chunks, so a dropped connection resumes' },
  { id: 'read', title: 'Read the policy', hint: 'PDF text layer first; scanned pages go through OCR in your browser' },
  { id: 'analyse', title: 'Rate and explain', hint: 'Extract facts, pick the insurer grid, resolve OD and TP with citations' },
];

export function Progress({ job }: { job: Job }) {
  const at = STEPS.findIndex((s) => s.id === job.step);
  return (
    <section className="card progress-card" aria-live="polite">
      <div className="progress-head">
        <span className="spinner" aria-hidden="true" />
        <div>
          <h2>Analysing {job.fileName ?? 'your policy'}</h2>
          <p className="muted">You can keep this tab open while it works. Closing it leaves a resumable run.</p>
        </div>
      </div>
      <ol className="stepper">
        {STEPS.map((s, i) => (
          <li key={s.id} className={i < at ? 'done' : i === at ? 'current' : ''}>
            <span className="step-dot">{i < at ? <Icon name="ok" size={14} /> : i + 1}</span>
            <div>
              <strong>{s.title}</strong>
              <span className="muted">{i === at ? job.label : s.hint}</span>
              {i === at && job.progress !== undefined && (
                <span className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(job.progress * 100)}>
                  <span style={{ width: `${Math.round(job.progress * 100)}%` }} />
                </span>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
