/**
 * HTTP clients the Print Operator Harness uses for deterministic actions.
 *
 *   - Local printer adapter (services/local-printer-agent): discovery,
 *     availability and config validation. The harness NEVER calls its /print
 *     endpoint; only the backend may submit a job, after authorization.
 *   - Inklink backend: the execution-request gate. The backend owns the
 *     authoritative job state and decides whether execution is allowed.
 *
 * All calls are bounded by a timeout and map failures to typed errors so a
 * tool can report a real failure instead of guessing.
 */
import type { OperatorPrintConfig, PrinterSummary } from '@inklink/shared-schemas';

export class ServiceCallError extends Error {
  constructor(
    public code: string,
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = 'ServiceCallError';
  }
}

function base(name: string, fallback: string): string {
  return (process.env[name] ?? fallback).trim().replace(/\/+$/, '');
}

async function call(url: string, init: RequestInit, timeoutMs: number, service: string): Promise<{ status: number; body: any }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new ServiceCallError(`${service}_TIMEOUT`, `${service} did not respond within ${Math.round(timeoutMs / 1000)}s.`);
    }
    throw new ServiceCallError(`${service}_UNREACHABLE`, `${service} is not reachable.`);
  } finally {
    clearTimeout(timer);
  }
}

/* ───────────── Local printer adapter ───────────── */

function printerHeaders(): Record<string, string> {
  const token = (process.env.PRINTER_AGENT_TOKEN ?? '').trim();
  return token ? { 'x-printer-agent-token': token } : {};
}

export const printerAdapter = {
  url: () => base('PRINTER_AGENT_URL', 'http://127.0.0.1:7777'),

  async listPrinters(): Promise<{ printers: PrinterSummary[]; defaultPrinter: string | null }> {
    const { status, body } = await call(`${this.url()}/printers`, { headers: printerHeaders() }, 20_000, 'PRINTER_ADAPTER');
    if (status !== 200 || !body?.ok) {
      throw new ServiceCallError(body?.error?.code ?? 'DISCOVERY_FAILED', body?.error?.message ?? 'Printer discovery failed.', status);
    }
    const printers: PrinterSummary[] = (body.printers ?? []).map((p: any) => ({
      id: String(p.id),
      name: String(p.name ?? p.id),
      status: ['online', 'offline', 'unknown'].includes(p.status) ? p.status : 'unknown',
      isDefault: Boolean(p.isDefault),
      supportsColor: typeof p.supportsColor === 'boolean' ? p.supportsColor : null,
      supportsDuplex: typeof p.supportsDuplex === 'boolean' ? p.supportsDuplex : null,
    }));
    return { printers, defaultPrinter: body.defaultPrinter ?? null };
  },

  async availability(printerId: string): Promise<{ available: boolean; status: string }> {
    const { status, body } = await call(
      `${this.url()}/printers/${encodeURIComponent(printerId)}/availability`,
      { headers: printerHeaders() },
      20_000,
      'PRINTER_ADAPTER',
    );
    if (status !== 200 || !body?.ok) {
      throw new ServiceCallError(body?.error?.code ?? 'DISCOVERY_FAILED', body?.error?.message ?? 'Availability check failed.', status);
    }
    return { available: Boolean(body.available), status: String(body.status) };
  },

  async validate(config: OperatorPrintConfig): Promise<{ ok: boolean; errors: string[] }> {
    const { status, body } = await call(
      `${this.url()}/validate`,
      { method: 'POST', headers: { ...printerHeaders(), 'content-type': 'application/json' }, body: JSON.stringify({ config }) },
      20_000,
      'PRINTER_ADAPTER',
    );
    if (status === 502 || body == null) {
      throw new ServiceCallError(body?.code ?? 'DISCOVERY_FAILED', 'Could not validate against the discovered printers.', status);
    }
    return { ok: Boolean(body.ok), errors: Array.isArray(body.errors) ? body.errors.map(String) : [] };
  },
};

/* ───────────── Inklink backend ───────────── */

export interface ExecutionRequestResult {
  accepted: boolean;
  /** Backend decision, e.g. "awaiting_customer_approval", "awaiting_payment", "authorized". */
  state: string;
  pending: string[];
  message: string;
}

export const backend = {
  url: () => base('BACKEND_URL', 'http://127.0.0.1:8000'),

  /** Ask the backend to schedule physical execution. The backend decides. */
  async requestExecution(jobId: string, runId: string, config: OperatorPrintConfig): Promise<ExecutionRequestResult> {
    const token = (process.env.AGENT_SERVICE_TOKEN ?? '').trim();
    if (!token) throw new ServiceCallError('AGENT_NOT_CONFIGURED', 'AGENT_SERVICE_TOKEN is not set; the backend cannot be called.');
    const { status, body } = await call(
      `${this.url()}/api/v1/internal/jobs/${encodeURIComponent(jobId)}/execution-requests`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ runId, config }),
      },
      20_000,
      'BACKEND',
    );
    if (status !== 200 || !body) {
      throw new ServiceCallError(body?.error?.code ?? 'EXECUTION_REQUEST_FAILED', body?.error?.message ?? `Backend returned ${status}.`, status);
    }
    return {
      accepted: Boolean(body.accepted),
      state: String(body.state),
      pending: Array.isArray(body.pending) ? body.pending.map(String) : [],
      message: String(body.message ?? ''),
    };
  },
};
