// Run records: one uploaded policy PDF, its extracted page text, the user's
// answers and every analysis revision. Shared by the API and the browser app,
// so this file must stay free of Node-only imports.
import type {
  AnalysisResult,
  FactOverrides,
  InsurerId,
  PageText,
  PolicyType,
  ResultStatus,
} from '../core/types';

/** Netlify caps function bodies around 6 MB (and base64 inflates binary), so PDFs travel in 2.5 MB chunks. */
export const CHUNK_SIZE = 2.5 * 1024 * 1024;
export const MAX_FILE_SIZE = 25 * 1024 * 1024;

export type RunStatus = 'uploading' | 'awaiting_text' | 'analysed' | 'failed';

export interface RunRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  fileName: string;
  fileSize: number;
  sha256: string;
  chunkCount: number;
  uploadedChunks: number[]; // sorted chunk indexes already stored
  status: RunStatus;
  pages: PageText[];
  overrides: FactOverrides;
  analyses: AnalysisResult[]; // every (re-)analysis appended, latest last
  error: string | null;
}

export interface RunSummary {
  id: string;
  createdAt: string;
  fileName: string;
  status: RunStatus;
  insurer: InsurerId | null;
  policyType: PolicyType | null;
  resultStatus: ResultStatus | null;
  odRate: number | null;
  tpRate: number | null;
}

/** Time-sortable id: zero-padded base36 epoch millis + 8 random chars. */
export function newRunId(now = Date.now()): string {
  return now.toString(36).padStart(9, '0') + crypto.randomUUID().replace(/-/g, '').slice(0, 8);
}

export const RUN_ID_RE = /^[0-9a-z]{9,40}$/;

export function expectedChunkCount(fileSize: number): number {
  return Math.max(1, Math.ceil(fileSize / CHUNK_SIZE));
}

/** Exact byte length chunk `index` must have, so reassembly is always byte-identical. */
export function chunkLength(fileSize: number, index: number): number {
  return Math.min(CHUNK_SIZE, fileSize - index * CHUNK_SIZE);
}

export function summarise(run: RunRecord): RunSummary {
  const latest = run.analyses.at(-1);
  return {
    id: run.id,
    createdAt: run.createdAt,
    fileName: run.fileName,
    status: run.status,
    insurer: latest ? (latest.result.insurer ?? latest.facts.insurer.value) : null,
    policyType: latest?.facts.policyType.value ?? null,
    resultStatus: latest?.result.status ?? null,
    odRate: latest?.result.od.ratePercent ?? null,
    tpRate: latest?.result.tp.ratePercent ?? null,
  };
}
