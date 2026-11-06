/**
 * Thin client for the Inklink backend (same-origin via the Vite proxy).
 *
 * Credentials:
 *  - web:  an anonymous, short-lived browser session (no login, no wallet),
 *          kept in sessionStorage;
 *  - shop: the shopkeeper's server-side session, carried by an HttpOnly cookie
 *          that JavaScript cannot read. Every request sends
 *          `X-Inklink-Request: 1` (the backend's CSRF guard for cookie auth);
 *  - jury: while the ETHGlobal jury demo is active, BOTH the customer and the
 *          shop views use the jury session, which the backend confines to
 *          the isolated demo shop and the judge's own jobs.
 * Errors follow the agreed envelope { success:false, error:{ code, message } }.
 */
import type {
  ConversationMessage,
  JobView,
  OperatorEvent,
  PaymentHandoff,
  PrinterSummary,
  Quote,
  ShopChannel,
  ShopConfig,
  ShopHardware,
  ShopOverview,
  ShopPayments,
  TrustMode,
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
const JURY_KEY = 'inklink.jury.session';

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

export interface JurySession {
  sessionToken: string;
  juryRef: string;
  demoShopId: string;
  expiresAt: string;
}

/** Jury demo mode: on while the /jury experience is open in this tab. */
export const jury = {
  session(): JurySession | null {
    try {
      const s = JSON.parse(sessionStorage.getItem(JURY_KEY) ?? 'null') as JurySession | null;
      return s && new Date(s.expiresAt).getTime() - Date.now() > 60_000 ? s : null;
    } catch {
      return null;
    }
  },
  active: false,
  enter(s: JurySession) {
    sessionStorage.setItem(JURY_KEY, JSON.stringify(s));
    jury.active = true;
  },
  activate() {
    jury.active = Boolean(jury.session());
  },
  exit() {
    jury.active = false;
  },
  forget() {
    sessionStorage.removeItem(JURY_KEY);
    jury.active = false;
  },
};

async function bearer(auth: AuthKind | null): Promise<string | null> {
  if (auth && jury.active) {
    const s = jury.session();
    if (s) return s.sessionToken;
  }
  if (auth === 'web') return (await ensureWebSession()).sessionToken;
  // Shop calls authenticate with the HttpOnly session cookie, never a JS-held token.
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
  const headers: Record<string, string> = { accept: 'application/json', 'x-inklink-request': '1', ...opts.headers };
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
    res = await fetch(path, { method, headers, body, credentials: 'same-origin' });
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
    if (res.status === 401 && (opts.auth ?? 'web') === 'web' && !jury.active) sessionStorage.removeItem(WEB_KEY);
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

  health: () =>
    request<{ ok: boolean; paymentsConfigured: boolean; zeroG: { defaultTrustMode: TrustMode; modes: Record<TrustMode, boolean> } }>(
      'GET',
      '/api/v1/health',
      { auth: null },
    ),

  setPrivacy: (jobId: string, requestedTrustMode: TrustMode | null) =>
    request<JobView>('PUT', `/api/v1/jobs/${enc(jobId)}/privacy`, { body: { requestedTrustMode } }),

  approveEdits: (jobId: string) => request<JobView>('POST', `/api/v1/jobs/${enc(jobId)}/document/approve`),
  rejectEdits: (jobId: string) => request<JobView>('POST', `/api/v1/jobs/${enc(jobId)}/document/reject`),

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
    hardware: () => request<ShopHardware>('GET', '/api/v1/shop/hardware', { auth: 'shop' }),
    payments: () => request<ShopPayments>('GET', '/api/v1/shop/payments', { auth: 'shop' }),
  },

  history: (jobId: string, auth: AuthKind = 'web') =>
    request<{ jobId: string; events: OperatorEvent[] }>('GET', `/api/v1/jobs/${enc(jobId)}/history`, { auth }),

  /** Shopkeeper authentication (HttpOnly cookie session). */
  shopAuth: {
    login: (email: string, password: string) =>
      request<ShopSessionView>('POST', '/api/v1/shop-auth/login', { auth: null, body: { email, password } }),
    me: () => request<ShopSessionView>('GET', '/api/v1/shop-auth/me', { auth: null }),
    setActiveShop: (shopId: string) => request<ShopSessionView>('PUT', '/api/v1/shop-auth/active-shop', { auth: null, body: { shopId } }),
    logout: () => request<{ ok: boolean }>('POST', '/api/v1/shop-auth/logout', { auth: null }),
  },

  /** ETHGlobal jury demo orchestration (jury session only). */
  jury: {
    createSession: () => request<JurySession>('POST', '/api/v1/jury/sessions', { auth: null }),
    status: () => request<{ integrations: Integration[]; demoShopId: string }>('GET', '/api/v1/jury/status', { auth: 'web' }),
    state: () => request<{ demoShopId: string; currentJobId: string | null; jobs: { jobId: string; status: string; filename: string | null; createdAt: string }[] }>(
      'GET', '/api/v1/jury/state', { auth: 'web' }),
    runFallback: (jobId: string, instruction?: string) =>
      request<{ started: boolean }>('POST', `/api/v1/jury/jobs/${enc(jobId)}/run-fallback`, { body: { instruction: instruction ?? null } }),
    approveQuote: (jobId: string) =>
      request<{ approved: boolean; handoff: PaymentHandoff | null; paymentsConfigured: boolean }>('POST', `/api/v1/jury/jobs/${enc(jobId)}/approve-quote`),
    payment: (jobId: string) => request<JuryPayment>('GET', `/api/v1/jury/jobs/${enc(jobId)}/payment`),
    simulatePayment: (jobId: string) => request<JobView>('POST', `/api/v1/jury/jobs/${enc(jobId)}/simulate-payment`),
    simulateExecution: (jobId: string) => request<JobView>('POST', `/api/v1/jury/jobs/${enc(jobId)}/simulate-execution`),
    lifecycle: (jobId: string) => request<JuryLifecycle>('GET', `/api/v1/jury/jobs/${enc(jobId)}/lifecycle`),
    reset: () => request<{ removed: string[] }>('POST', '/api/v1/jury/reset'),
  },
};

export interface ShopSessionView {
  account: { accountId: string; email: string; name: string; role: string };
  shops: { shopId: string; name: string; demo: boolean; acceptingOrders: boolean }[];
  activeShopId: string | null;
  expiresAt: string;
}

export interface Integration {
  id: string;
  label: string;
  state: 'live' | 'configured' | 'configured_unverified' | 'not_configured' | 'unavailable' | 'simulated' | 'online' | 'offline' | 'never_seen';
  detail: string;
}

export interface JuryPayment {
  quote: { quoteId: string; amountInr: string; amountUsdc: string | null; rate: string | null; capturedAt: string; expiresAt: string; paymentMethods: string[] } | null;
  customerApproved: boolean;
  paymentsConfigured: boolean;
  x402Requirement: { network: string; asset: string; amount: string; payTo: string; resource: string } | null;
  realPayment: { paymentId: string; status: string; transactionId: string | null; hashscanUrl: string | null } | null;
  paymentStatus: string;
  simulated: { state: string; at: string; note: string } | null;
}

export interface JuryLifecycle {
  jobId: string;
  stages: { id: string; label: string; state: string; mode: 'real' | 'simulated'; detail?: string | null }[];
  events: number;
  chainRecords: { kind: string; at: string; status: string; data: Record<string, unknown> }[];
}

function enc(s: string) {
  return encodeURIComponent(s);
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return 'Something went wrong.';
}
