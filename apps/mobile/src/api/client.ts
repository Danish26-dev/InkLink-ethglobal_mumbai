/**
 * Inklink API client — the app talks ONLY to the Inklink backend / shop gateway
 * (never to the payment agent). Contracts 1-8 all go through one base URL:
 *   Local:  http://<gateway>:<port>/api/v1   (from the verified QR, never hardcoded)
 *   Cloud:  https://<inklink-cloud>/api/v1    (not provisioned yet)
 *
 * Every call after pairing carries `Authorization: Bearer <session token>`. If the
 * session has expired the client re-runs the pairing handshake once (the gateway's
 * key is already pinned from the QR) and retries.
 */

import {
  isErrorEnvelope,
  type AuthorizePaymentRequest,
  type AuthorizePaymentResponse,
  type CreateJobRequest,
  type CreateJobResponse,
  type DocumentUploadResponse,
  type ErrorEnvelope,
  type InitiatePaymentRequest,
  type InitiatePaymentResponse,
  type JobStatusResponse,
  type PaymentStatusResponse,
  type Quote,
  type Shop,
} from "@inklink/shared-schemas";

import {
  UploadAbortedError,
  UploadNetworkError,
  backoffMs,
  isRetryableStatus,
  xhrTransport,
  type UploadResult,
  type UploadTransport,
} from "./upload";

const MAX_UPLOAD_ATTEMPTS = 3;

export interface UploadProgress {
  /** Bytes sent in the current attempt. */
  sent: number;
  total: number;
  attempt: number;
  maxAttempts: number;
}

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

export interface ApiSession {
  token: string;
  expiresAt: string;
}

export class InklinkApi {
  private baseUrl = "";
  private session: ApiSession | null = null;

  /** Set by the app: re-runs the pairing handshake; true if a new session was installed. */
  reauthenticate?: () => Promise<boolean>;

  /** Point at a verified gateway origin, e.g. http://192.168.1.20:8000 */
  configure(origin: string) {
    this.baseUrl = `${origin.replace(/\/$/, "")}/api/v1`;
  }

  /** Origin without /api/v1 (for /health probes). */
  get origin(): string {
    return this.baseUrl.replace(/\/api\/v1$/, "");
  }

  get isConfigured(): boolean {
    return this.baseUrl !== "";
  }

  setSession(session: ApiSession | null) {
    this.session = session;
  }

  private authHeaders(): Record<string, string> {
    return this.session ? { Authorization: `Bearer ${this.session.token}` } : {};
  }

  private async send(path: string, init: RequestInit, retried = false): Promise<Response> {
    if (!this.isConfigured) {
      throw new ApiError("GATEWAY_UNREACHABLE", "No shop connected. Scan the shop's QR code first.");
    }
    if (!this.session) {
      throw new ApiError("UNAUTHORIZED", "Not paired with the shop yet.", 401);
    }
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), ...this.authHeaders() },
      });
    } catch {
      throw new ApiError("GATEWAY_UNREACHABLE", "The shop gateway is unreachable.");
    }
    if (res.status === 401 && !retried && this.reauthenticate) {
      if (await this.reauthenticate()) return this.send(path, init, true);
    }
    return res;
  }

  private parseBody<T>(text: string, status: number): T {
    let data: T | ErrorEnvelope;
    try {
      data = JSON.parse(text) as T | ErrorEnvelope;
    } catch {
      throw new ApiError("INTERNAL_ERROR", `Unexpected response (HTTP ${status})`, status);
    }
    if (isErrorEnvelope(data)) throw new ApiError(data.error.code, data.error.message, status);
    if (status < 200 || status >= 300) {
      throw new ApiError("INTERNAL_ERROR", `Unexpected response (HTTP ${status})`, status);
    }
    return data as T;
  }

  private async parse<T>(res: Response): Promise<T> {
    return this.parseBody<T>(await res.text(), res.status);
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.send(path, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init.headers as Record<string, string> | undefined) },
    });
    return this.parse<T>(res);
  }

  /** Unauthenticated reachability probe (GET /health on the origin). */
  async ping(): Promise<boolean> {
    if (!this.isConfigured) return false;
    try {
      return (await fetch(`${this.origin}/health`)).ok;
    } catch {
      return false;
    }
  }

  // Contract 1
  getShop(shopId: string): Promise<Shop> {
    return this.json<Shop>(`/shops/${shopId}`);
  }

  // Contract 3 (call first: the gateway/backend mints the authoritative jobId)
  createJob(body: CreateJobRequest): Promise<CreateJobResponse> {
    return this.json<CreateJobResponse>(`/jobs`, { method: "POST", body: JSON.stringify(body) });
  }

  /**
   * Contract 2 — multipart upload against the existing jobId, over local Wi-Fi.
   *
   * Reports progress, and survives an interrupted transfer: network failures and transient
   * 5xx/408/429 responses are retried (up to 3 attempts, with backoff) by re-sending the whole
   * file with the SAME Idempotency-Key, so the gateway never creates a duplicate document.
   * Anything else (bad file type, too large, no session) fails immediately. A 401 silently
   * re-runs the pairing handshake once. The caller can cancel with an AbortSignal.
   */
  async uploadDocument(args: {
    fileUri: string;
    fileName: string;
    mimeType: string;
    shopId: string;
    customerId: string;
    jobId: string;
    idempotencyKey: string;
    onProgress?: (p: UploadProgress) => void;
    /** Called before waiting to retry: which attempt just failed and why. */
    onRetry?: (failedAttempt: number, reason: string) => void;
    signal?: AbortSignal;
    /** Injected for tests; defaults to the XMLHttpRequest transport. */
    transport?: UploadTransport;
    sleep?: (ms: number) => Promise<void>;
  }): Promise<DocumentUploadResponse> {
    if (!this.isConfigured) {
      throw new ApiError("GATEWAY_UNREACHABLE", "No shop connected. Scan the shop's QR code first.");
    }
    if (!this.session) throw new ApiError("UNAUTHORIZED", "Not paired with the shop yet.", 401);

    const transport = args.transport ?? xhrTransport;
    const sleep = args.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const url = `${this.baseUrl}/documents`;
    let reauthenticated = false;

    for (let attempt = 1; ; attempt++) {
      const report = (sent: number, total: number) =>
        args.onProgress?.({ sent, total, attempt, maxAttempts: MAX_UPLOAD_ATTEMPTS });

      let result: UploadResult;
      try {
        result = await transport(
          url,
          {
            file: { uri: args.fileUri, name: args.fileName, type: args.mimeType },
            fields: { shopId: args.shopId, customerId: args.customerId, jobId: args.jobId },
            headers: { "Idempotency-Key": args.idempotencyKey, ...this.authHeaders() },
          },
          report,
          args.signal,
        );
      } catch (err) {
        if (err instanceof UploadAbortedError) {
          throw new ApiError("UPLOAD_FAILED", "Upload cancelled");
        }
        if (err instanceof UploadNetworkError) {
          if (attempt >= MAX_UPLOAD_ATTEMPTS) {
            throw new ApiError(
              "UPLOAD_FAILED",
              `The upload was interrupted and did not complete after ${MAX_UPLOAD_ATTEMPTS} attempts (${err.message}). Check you are still on the shop's Wi-Fi and try again.`,
            );
          }
          args.onRetry?.(attempt, err.message);
          await sleep(backoffMs(attempt));
          continue;
        }
        throw err;
      }

      // Expired session: renew it once and resend. Not counted as a failed attempt.
      if (result.status === 401 && !reauthenticated && this.reauthenticate) {
        reauthenticated = true;
        if (await this.reauthenticate()) {
          attempt--;
          continue;
        }
      }

      if (result.status >= 200 && result.status < 300) {
        return this.parseBody<DocumentUploadResponse>(result.body, result.status);
      }

      if (isRetryableStatus(result.status) && attempt < MAX_UPLOAD_ATTEMPTS) {
        args.onRetry?.(attempt, `The shop gateway answered HTTP ${result.status}`);
        await sleep(backoffMs(attempt));
        continue;
      }

      // Final failure: surface the gateway's own error code (e.g. UNSUPPORTED_FORMAT).
      return this.parseBody<DocumentUploadResponse>(result.body, result.status);
    }
  }

  // Contract 4 — INR quote plus the backend-computed USDC settlement (display only)
  generateQuote(jobId: string): Promise<Quote> {
    return this.json<Quote>(`/jobs/${jobId}/quote`, { method: "POST" });
  }

  // Contract 5 — device-signed spending policy
  authorizePayment(req: AuthorizePaymentRequest): Promise<AuthorizePaymentResponse> {
    return this.json<AuthorizePaymentResponse>(`/payments/authorizations`, {
      method: "POST",
      body: JSON.stringify(req),
    });
  }

  // Contract 6 — the backend, not the app, determines the USDC amount
  initiatePayment(req: InitiatePaymentRequest): Promise<InitiatePaymentResponse> {
    return this.json<InitiatePaymentResponse>(`/payments`, { method: "POST", body: JSON.stringify(req) });
  }

  // Contract 7
  getPaymentStatus(paymentId: string): Promise<PaymentStatusResponse> {
    return this.json<PaymentStatusResponse>(`/payments/${paymentId}`);
  }

  // Contract 8 — authoritative status lives on the backend
  getJobStatus(jobId: string): Promise<JobStatusResponse> {
    return this.json<JobStatusResponse>(`/jobs/${jobId}/status`);
  }
}
