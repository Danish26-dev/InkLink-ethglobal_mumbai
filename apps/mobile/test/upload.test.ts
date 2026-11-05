/**
 * Upload retry behaviour, tested with a fake transport (no network).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ApiError, InklinkApi } from "../src/api/client";
import {
  UploadAbortedError,
  UploadNetworkError,
  backoffMs,
  isRetryableStatus,
  type UploadRequestBody,
  type UploadResult,
  type UploadTransport,
} from "../src/api/upload";

const OK_BODY = JSON.stringify({ documentId: "doc_1", jobId: "job_1", status: "uploaded" });
const ok = (): UploadResult => ({ status: 201, body: OK_BODY });

function scripted(steps: Array<UploadResult | Error>) {
  const calls: UploadRequestBody[] = [];
  const transport: UploadTransport = async (_url, request, onProgress) => {
    calls.push(request);
    onProgress(50, 100);
    const step = steps[calls.length - 1];
    if (!step) throw new Error("transport called more often than scripted");
    if (step instanceof Error) throw step;
    return step;
  };
  return { transport, calls };
}

function makeApi() {
  const api = new InklinkApi();
  api.configure("http://10.0.0.5:8000");
  api.setSession({ token: "tok_1", expiresAt: "2099-01-01T00:00:00Z" });
  return api;
}

const base = {
  fileUri: "file:///x.pdf",
  fileName: "x.pdf",
  mimeType: "application/pdf",
  shopId: "shop_1",
  customerId: "cust_1",
  jobId: "job_1",
  idempotencyKey: "idem-1",
};

describe("upload retry policy", () => {
  it("backs off 800ms, 1.6s, 3.2s and caps at 5s", () => {
    assert.deepEqual([1, 2, 3, 4, 5].map(backoffMs), [800, 1600, 3200, 5000, 5000]);
  });

  it("retries only transient statuses", () => {
    assert.equal(isRetryableStatus(503), true);
    assert.equal(isRetryableStatus(429), true);
    assert.equal(isRetryableStatus(408), true);
    assert.equal(isRetryableStatus(400), false);
    assert.equal(isRetryableStatus(415), false);
  });
});

describe("uploadDocument", () => {
  it("sends fields, auth and idempotency key, and reports progress", async () => {
    const { transport, calls } = scripted([ok()]);
    const progress: number[] = [];
    const res = await makeApi().uploadDocument({
      ...base,
      transport,
      onProgress: (p) => progress.push(p.sent),
    });
    assert.equal(res.documentId, "doc_1");
    assert.deepEqual(calls[0].fields, { shopId: "shop_1", customerId: "cust_1", jobId: "job_1" });
    assert.equal(calls[0].headers["Idempotency-Key"], "idem-1");
    assert.equal(calls[0].headers.Authorization, "Bearer tok_1");
    assert.deepEqual(progress, [50]);
  });

  it("retries a dropped connection with the SAME idempotency key", async () => {
    const { transport, calls } = scripted([
      new UploadNetworkError("dropped"),
      new UploadNetworkError("dropped"),
      ok(),
    ]);
    const sleeps: number[] = [];
    const retries: number[] = [];
    const res = await makeApi().uploadDocument({
      ...base,
      transport,
      sleep: async (ms) => void sleeps.push(ms),
      onRetry: (n) => retries.push(n),
    });
    assert.equal(res.documentId, "doc_1");
    assert.equal(calls.length, 3);
    assert.deepEqual(sleeps, [800, 1600]);
    assert.deepEqual(retries, [1, 2]);
    assert.ok(calls.every((c) => c.headers["Idempotency-Key"] === "idem-1"));
  });

  it("retries a 503", async () => {
    const { transport, calls } = scripted([{ status: 503, body: "" }, ok()]);
    await makeApi().uploadDocument({ ...base, transport, sleep: async () => {} });
    assert.equal(calls.length, 2);
  });

  it("does not retry a 400 and surfaces the gateway's error code", async () => {
    const body = JSON.stringify({ success: false, error: { code: "UNSUPPORTED_FORMAT", message: "no" } });
    const { transport, calls } = scripted([{ status: 400, body }]);
    await assert.rejects(
      makeApi().uploadDocument({ ...base, transport, sleep: async () => {} }),
      (e: unknown) => e instanceof ApiError && e.code === "UNSUPPORTED_FORMAT" && e.status === 400,
    );
    assert.equal(calls.length, 1);
  });

  it("gives up after 3 attempts", async () => {
    const { transport, calls } = scripted([
      new UploadNetworkError("a"),
      new UploadNetworkError("b"),
      new UploadNetworkError("c"),
    ]);
    await assert.rejects(
      makeApi().uploadDocument({ ...base, transport, sleep: async () => {} }),
      (e: unknown) => e instanceof ApiError && e.code === "UPLOAD_FAILED",
    );
    assert.equal(calls.length, 3);
  });

  it("gives up after 3 attempts on persistent 503 with the gateway's envelope", async () => {
    const body = JSON.stringify({ success: false, error: { code: "GATEWAY_BUSY", message: "busy" } });
    const { transport, calls } = scripted([
      { status: 503, body },
      { status: 503, body },
      { status: 503, body },
    ]);
    await assert.rejects(
      makeApi().uploadDocument({ ...base, transport, sleep: async () => {} }),
      (e: unknown) => e instanceof ApiError && e.code === "GATEWAY_BUSY",
    );
    assert.equal(calls.length, 3);
  });

  it("re-authenticates once on 401 without spending an attempt", async () => {
    const { transport, calls } = scripted([{ status: 401, body: "" }, ok()]);
    const api = makeApi();
    let reauths = 0;
    api.reauthenticate = async () => {
      reauths++;
      api.setSession({ token: "tok_2", expiresAt: "2099-01-01T00:00:00Z" });
      return true;
    };
    await api.uploadDocument({ ...base, transport });
    assert.equal(reauths, 1);
    assert.equal(calls[1].headers.Authorization, "Bearer tok_2");
  });

  it("turns a cancel into a non-retried UPLOAD_FAILED", async () => {
    const { transport, calls } = scripted([new UploadAbortedError()]);
    await assert.rejects(
      makeApi().uploadDocument({ ...base, transport }),
      (e: unknown) => e instanceof ApiError && e.message === "Upload cancelled",
    );
    assert.equal(calls.length, 1);
  });

  it("fails fast when not configured or not paired", async () => {
    const { transport } = scripted([]);
    await assert.rejects(new InklinkApi().uploadDocument({ ...base, transport }), (e: unknown) => e instanceof ApiError && e.code === "GATEWAY_UNREACHABLE");
    const api = new InklinkApi();
    api.configure("http://10.0.0.5:8000");
    await assert.rejects(api.uploadDocument({ ...base, transport }), (e: unknown) => e instanceof ApiError && e.code === "UNAUTHORIZED");
  });
});
