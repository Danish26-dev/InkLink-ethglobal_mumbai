/**
 * Thin client for the Inklink backend (same-origin via the Vite proxy).
 *
 * Two credentials exist, both kept in sessionStorage (cleared with the tab):
 *  - web: an anonymous, short-lived browser session (no login, no wallet);
 *  - shop: the shop admin token the shopkeeper types into the dashboard.
 * Errors follow the agreed envelope { success:false, error:{ code, message } }.
 */
import type {
  ConversationMessage,
  JobView,
  PaymentHandoff,
  PrinterSummary,
  Quote,
  ShopChannel,
  ShopConfig,
  ShopOverview,
  WebSession,
} from '@inklink/shared-schemas';

export type AuthKind = 'web' | 'shop';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const WEB_KEY = 'inklink.web.session';
const SHOP_KEY = 'inklink.shop.token';

/* ───────────── credentials ───────────── */

function storedWebSession(): WebSession | null {
  try {
    const raw = sessionStorage.getItem(WEB_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as WebSession;
    // Renew a minute early so a request never races the expiry.
    return new Date(s.expiresAt).getTime() - Date.now() > 60_000 ? s : null;
  } catch {
    return null;
  }
}

let pendingSession: Promise<WebSession> | null = null;

export async function ensureWebSession(): Promise<WebSession> {
  const existing = storedWebSession();
  if (existing) return existing;
  pendingSession ??= request<WebSession>('POST', '/api/v1/web/sessions', { auth: null })
    .then((s) => {
      sessionStorage.setItem(WEB_KEY, JSON.stringify(s));
      return s;
    })
    .finally(() => {
      pendingSession = null;
    });
  return pendingSession;
}

export const shopToken = {
  get: (): string | null => sessionStorage.getItem(SHOP_KEY),
  set: (t: string) => sessionStorage.setItem(SHOP_KEY, t),
  clear: () => sessionStorage.removeItem(SHOP_KEY),
};

async function bearer(auth: AuthKind | null): Promise<string | null> {
  if (auth === 'web') return (await ensureWebSession()).sessionToken;
  if (auth === 'shop') return shopToken.get();
  return null;
}

/* ───────────── transport ───────────── */

interface RequestOptions {
  auth?: AuthKind | null;
  body?: unknown;
  form?: FormData;
  headers?: Record<string, string>;
}

async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };
  const token = await bearer(opts.auth === undefined ? 'web' : opts.auth);
  if (token) headers.authorization = `Bearer ${token}`;
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetch(path, { method, headers, body });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'The Inklink backend is not reachable.');
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
    // An expired web session: drop it so the next call creates a fresh one.
    if (res.status === 401 && (opts.auth ?? 'web') === 'web') sessionStorage.removeItem(WEB_KEY);
    throw new ApiError(res.status, err?.code ?? 'INTERNAL_ERROR', err?.message ?? `Request failed (${res.status}).`);
  }
  return data as T;
}

/* ───────────── endpoints ───────────── */

export const api = {
  shops: () => request<ShopChannel[]>('GET', '/api/v1/shops'),

  createJob: (shopId: string) =>
    request<{ jobId: string; status: string; createdAt: string }>('POST', '/api/v1/jobs', { body: { shopId } }),

  job: (jobId: string, auth: AuthKind = 'web') => request<JobView>('GET', `/api/v1/jobs/${enc(jobId)}`, { auth }),

  messages: (jobId: string, auth: AuthKind = 'web') =>
    request<ConversationMessage[]>('GET', `/api/v1/jobs/${enc(jobId)}/messages`, { auth }),

  sendMessage: (jobId: string, text: string) =>
    request<ConversationMessage>('POST', `/api/v1/jobs/${enc(jobId)}/messages`, { body: { text } }),

  async upload(jobId: string, file: File) {
    const session = await ensureWebSession();
    const form = new FormData();
    form.append('file', file);
    form.append('jobId', jobId);
    form.append('customerId', session.customerReference);
    return request<{ documentId: string; filename: string; format: string; size: number }>('POST', '/api/v1/documents', {
      form,
      headers: { 'Idempotency-Key': `${jobId}:${file.name}:${file.size}:${file.lastModified}` },
    });
  },

  ticket: (jobId: string, auth: AuthKind = 'web') =>
    request<{ ticket: string; expiresInSeconds: number }>('POST', `/api/v1/jobs/${enc(jobId)}/tickets`, { auth }),

  /** Short-lived URL for the document preview (single-use ticket, no bearer in the URL). */
  async documentUrl(jobId: string, version: 'original' | 'current', auth: AuthKind = 'web') {
    const { ticket } = await api.ticket(jobId, auth);
    return `/api/v1/jobs/${enc(jobId)}/document?ticket=${enc(ticket)}&version=${version}`;
  },

  quote: (jobId: string) => request<Quote>('POST', `/api/v1/jobs/${enc(jobId)}/quote`),

  approveQuote: (jobId: string) => request<PaymentHandoff>('POST', `/api/v1/jobs/${enc(jobId)}/quote/approve`),

  shop: {
    overview: () => request<ShopOverview>('GET', '/api/v1/shop/overview', { auth: 'shop' }),
    setAvailability: (acceptingOrders: boolean) =>
      request<{ acceptingOrders: boolean }>('PUT', '/api/v1/shop/availability', { auth: 'shop', body: { acceptingOrders } }),
    jobs: () => request<JobView[]>('GET', '/api/v1/shop/jobs', { auth: 'shop' }),
    approve: (jobId: string) =>
      request<{ job: JobView; execution: { state: string; pending: string[]; message?: string } }>(
        'POST',
        `/api/v1/shop/jobs/${enc(jobId)}/approve`,
        { auth: 'shop' },
      ),
    complete: (jobId: string) => request<JobView>('POST', `/api/v1/shop/jobs/${enc(jobId)}/complete`, { auth: 'shop' }),
    printers: () =>
      request<{ reachable: boolean; printers: PrinterSummary[]; defaultPrinter: string | null; error: string | null }>(
        'GET',
        '/api/v1/shop/printers',
        { auth: 'shop' },
      ),
    config: () => request<ShopConfig & { defaults?: Record<string, unknown> }>('GET', '/api/v1/shop/config', { auth: 'shop' }),
    saveConfig: (cfg: ShopConfig) => request<ShopConfig>('PUT', '/api/v1/shop/config', { auth: 'shop', body: cfg }),
    pairingQr: () => request<{ qrText: string; expiresAt: string }>('GET', '/api/v1/shop/pairing-qr', { auth: 'shop' }),
  },
};

function enc(s: string) {
  return encodeURIComponent(s);
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return 'Something went wrong.';
}
