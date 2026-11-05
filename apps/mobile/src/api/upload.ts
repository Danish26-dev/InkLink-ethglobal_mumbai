/**
 * Document upload transport.
 *
 * fetch() cannot report upload progress, so the real transport uses XMLHttpRequest
 * (supported in React Native and the browser). The client logic that decides WHEN to retry
 * lives in client.ts and talks to this module only through the `UploadTransport` type, so
 * it can be tested without a network.
 *
 * Documents only ever travel to the paired shop gateway, never over BLE and never to cloud
 * storage.
 */

export interface UploadFile {
  uri: string;
  name: string;
  type: string;
}

export interface UploadRequestBody {
  file: UploadFile;
  /** Plain text fields sent alongside the file (shopId, customerId, jobId). */
  fields: Record<string, string>;
  /** Includes Authorization and Idempotency-Key. Content-Type is set by the transport. */
  headers: Record<string, string>;
}

export interface UploadResult {
  status: number;
  body: string;
}

export type UploadTransport = (
  url: string,
  request: UploadRequestBody,
  onProgress: (sent: number, total: number) => void,
  signal?: AbortSignal,
) => Promise<UploadResult>;

/** The request never got a response (connection dropped, timeout, unreachable). Retryable. */
export class UploadNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadNetworkError";
  }
}

/** The caller cancelled the upload. Never retried. */
export class UploadAbortedError extends Error {
  constructor() {
    super("Upload cancelled");
    this.name = "UploadAbortedError";
  }
}

/** Transient server-side failures worth retrying. Other 4xx are final (bad file, no session). */
export function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

/** 800 ms, 1.6 s, 3.2 s … capped at 5 s. */
export function backoffMs(attempt: number): number {
  return Math.min(5000, 800 * 2 ** (attempt - 1));
}

const UPLOAD_TIMEOUT_MS = 120_000;

const isWeb = () => typeof document !== "undefined";

/** XMLHttpRequest transport with real upload progress. */
export const xhrTransport: UploadTransport = async (url, request, onProgress, signal) => {
  const form = new FormData();
  if (isWeb()) {
    // Browsers need a Blob; the document picker gives a blob/object URL.
    const blob = await (await fetch(request.file.uri)).blob();
    form.append("file", blob, request.file.name);
  } else {
    // React Native streams the file from its URI when appended in this shape.
    form.append("file", {
      uri: request.file.uri,
      name: request.file.name,
      type: request.file.type,
    } as unknown as Blob);
  }
  for (const [k, v] of Object.entries(request.fields)) form.append(k, v);

  return new Promise<UploadResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    // Do NOT set Content-Type: the runtime adds the multipart boundary itself.
    for (const [k, v] of Object.entries(request.headers)) xhr.setRequestHeader(k, v);
    xhr.timeout = UPLOAD_TIMEOUT_MS;

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    };
    xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText });
    xhr.onerror = () => reject(new UploadNetworkError("The connection to the shop dropped"));
    xhr.ontimeout = () => reject(new UploadNetworkError("The upload timed out"));
    xhr.onabort = () => reject(new UploadAbortedError());

    if (signal) {
      if (signal.aborted) {
        reject(new UploadAbortedError());
        return;
      }
      signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }
    xhr.send(form);
  });
};
