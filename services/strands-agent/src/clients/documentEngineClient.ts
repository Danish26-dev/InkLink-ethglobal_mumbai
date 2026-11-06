/**
 * HTTP client for the Python Document Engine.
 *
 * The Document Engine is the deterministic authority for conversion, editing,
 * and validation. This client never edits documents itself; it only calls the
 * engine's endpoints:
 *   POST /inspect  -> extract document text
 *   POST /process  -> apply a validated OperationPlan
 *   GET  /operations -> supported operation types
 */
// Node 18+/22+ provides global fetch, FormData, and Blob (undici under the hood).
import type { OperationPlan } from '../schema.js';
import { serviceAuthHeaders } from './serviceAuth.js';

// The Document Engine URL is a non-secret setting resolved directly from the
// environment so this client works in tests that don't configure a model.
// The localhost default is for local development only; deployments must set
// DOCUMENT_ENGINE_URL.
function documentEngineUrl(): string {
  return (process.env.DOCUMENT_ENGINE_URL ?? 'http://localhost:5001').replace(/\/+$/, '');
}

// Per-call timeout budgets (ms). These form the INNER tier of the call-chain
// timeout ladder, so the agent's call to the engine fails first with a specific
// error rather than the caller aborting the whole request generically:
//
//   engine LibreOffice convert (CONVERT_TIMEOUT, 150s)
//     < agent -> engine /process (165s)
//     < caller (Inklink backend) -> agent  (must be configured above this)
//
// `process` includes a possible cold LibreOffice start for the PDF conversion
// fallback, so it gets the larger budget. `inspect` only extracts text.
const INSPECT_TIMEOUT_MS = Number(process.env.ENGINE_INSPECT_TIMEOUT_MS ?? 90_000);
const PROCESS_TIMEOUT_MS = Number(process.env.ENGINE_PROCESS_TIMEOUT_MS ?? 165_000);

/** Run a fetch with a bounded AbortController timeout. Maps an abort to a typed
 * ENGINE_TIMEOUT error so the orchestrator can surface a clean, specific
 * failure instead of hanging indefinitely. */
async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const auth = await serviceAuthHeaders(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), ...auth }, signal: controller.signal });
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new DocumentEngineError({
        code: 'engine_timeout',
        message: `The document service took too long to respond (> ${Math.round(ms / 1000)}s).`,
        status: 504,
      });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export interface InspectResult {
  job_id: string;
  text: string;
  chars: number;
}

export interface EngineChangeSummary {
  total_replacements: number;
  operations: Array<{ type: string; description: string; details: Record<string, unknown> }>;
  /** Which edit strategy produced the output: native_pdf | conversion | docx_direct. */
  strategy?: string;
}

export interface EngineValidationReport {
  ok: boolean;
  output_format: string;
  page_count: number | null;
  strategy: string | null;
  review_recommended: boolean;
  structure: Record<string, unknown>;
  notes: string[];
}

export interface ProcessResult {
  job_id: string;
  input_format: string;
  output_format: string;
  output_filename: string;
  changes: EngineChangeSummary;
  validation?: EngineValidationReport;
  download_url: string;
}

export interface EngineError {
  code: string;
  message: string;
  status: number;
}

export class DocumentEngineError extends Error {
  code: string;
  status: number;
  constructor(err: EngineError) {
    super(err.message);
    this.name = 'DocumentEngineError';
    this.code = err.code;
    this.status = err.status;
  }
}

async function parseError(res: Response): Promise<EngineError> {
  let code = 'engine_error';
  let message = `Document Engine returned ${res.status}`;
  try {
    const body = (await res.json()) as any;
    const detail = body?.detail ?? body?.error ?? body;
    if (detail && typeof detail === 'object') {
      code = detail.code ?? code;
      message = detail.message ?? message;
    }
  } catch {
    /* non-JSON body; keep defaults */
  }
  return { code, message, status: res.status };
}

function fileForm(fileBuffer: Buffer, filename: string, extra: Record<string, string> = {}): FormData {
  const form = new FormData();
  // Wrap the Buffer in a Uint8Array view for the Blob constructor.
  form.set('file', new Blob([new Uint8Array(fileBuffer)]), filename);
  for (const [k, v] of Object.entries(extra)) {
    form.set(k, v);
  }
  return form;
}

export const documentEngine = {
  async supportedOperations(): Promise<string[]> {
    const url = `${documentEngineUrl()}/operations`;
    const res = await fetch(url, { headers: await serviceAuthHeaders(url) });
    if (!res.ok) throw new DocumentEngineError(await parseError(res));
    const body = (await res.json()) as { supported_operations: string[] };
    return body.supported_operations;
  },

  async inspect(fileBuffer: Buffer, filename: string): Promise<InspectResult> {
    const form = fileForm(fileBuffer, filename);
    const res = await fetchWithTimeout(
      `${documentEngineUrl()}/inspect`,
      { method: 'POST', body: form },
      INSPECT_TIMEOUT_MS,
    );
    if (!res.ok) throw new DocumentEngineError(await parseError(res));
    return (await res.json()) as InspectResult;
  },

  /**
   * Apply a validated plan. No output format is sent: the engine always
   * returns the document in the format it was uploaded in.
   */
  async process(fileBuffer: Buffer, filename: string, plan: OperationPlan): Promise<ProcessResult> {
    const form = fileForm(fileBuffer, filename, { plan: JSON.stringify(plan) });
    const res = await fetchWithTimeout(
      `${documentEngineUrl()}/process`,
      { method: 'POST', body: form },
      PROCESS_TIMEOUT_MS,
    );
    if (!res.ok) throw new DocumentEngineError(await parseError(res));
    return (await res.json()) as ProcessResult;
  },

  async health(): Promise<boolean> {
    try {
      const url = `${documentEngineUrl()}/health`;
      const res = await fetch(url, { headers: await serviceAuthHeaders(url) });
      return res.ok;
    } catch {
      return false;
    }
  },
};
