import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { PaymentSettledEvent } from "@inklink/shared-schemas";
import {
  buildCallbackRequest,
  deliverCallback,
  hashscanUrlFor,
  isRetryableStatus,
  signCallback,
} from "../src/settlement.js";

const SECRET = "s3cret-s3cret-s3cret";
const event: PaymentSettledEvent = {
  paymentId: "payment_1",
  jobId: "job_1",
  payerAccount: "0.0.1001",
  merchantAccountId: "0.0.2002",
  network: "hedera:testnet",
  asset: "HTS_USDC",
  amount: "0.10",
  transactionId: "0.0.7162784@1700000000.000000001",
  settlementTimestamp: "2023-11-14T22:13:20.123Z",
  status: "settled",
  hashscanUrl: hashscanUrlFor("0.0.7162784@1700000000.000000001"),
};

describe("callback signing (raw body + timestamp)", () => {
  it("is verifiable by anyone who knows the secret, using only the raw bytes", () => {
    const { body, headers } = buildCallbackRequest(event, SECRET, 1_700_000_000_000);
    assert.equal(headers["X-Inklink-Timestamp"], "1700000000");
    assert.equal(headers["Idempotency-Key"], "payment_1");

    // What the backend does (Python: hmac.new(secret, f"{ts}.".encode()+raw, sha256)):
    const expected =
      "sha256=" +
      crypto.createHmac("sha256", SECRET).update(`1700000000.${body}`).digest("hex");
    assert.equal(headers["X-Inklink-Signature"], expected);
  });

  it("changes if the body or the timestamp changes (timestamp is inside the MAC)", () => {
    const base = signCallback('{"a":1}', "1700000000", SECRET);
    assert.notEqual(base, signCallback('{"a":2}', "1700000000", SECRET));
    assert.notEqual(base, signCallback('{"a":1}', "1700000001", SECRET));
    assert.notEqual(base, signCallback('{"a":1}', "1700000000", "other-secret-other"));
  });

  it("carries authentication in headers only: no signature field in the JSON", () => {
    const { body } = buildCallbackRequest(event, SECRET);
    assert.equal("signature" in JSON.parse(body), false);
  });
});

describe("hashscan url", () => {
  it("is derived from the real transaction id", () => {
    assert.equal(
      hashscanUrlFor("0.0.7162784@1700000000.000000001"),
      "https://hashscan.io/testnet/transaction/0.0.7162784-1700000000-000000001",
    );
  });
});

describe("deliverCallback retries", () => {
  const noSleep = { sleep: async () => {} };
  const respond = (status: number) => new Response(null, { status });

  it("retries 5xx with exponential backoff, then succeeds", async () => {
    const statuses = [503, 502, 200];
    const sleeps: number[] = [];
    let calls = 0;
    const result = await deliverCallback(event, {
      url: "http://backend/x", secret: SECRET, maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 30_000,
      fetchImpl: (async () => respond(statuses[calls++])) as typeof fetch,
      sleep: async (ms) => { sleeps.push(ms); },
    });
    assert.deepEqual({ delivered: result.delivered, attempts: result.attempts }, { delivered: true, attempts: 3 });
    // 1s then 2s, each with ±20% jitter.
    assert.equal(sleeps.length, 2);
    assert.ok(sleeps[0] >= 800 && sleeps[0] <= 1200, `first backoff ${sleeps[0]}`);
    assert.ok(sleeps[1] >= 1600 && sleeps[1] <= 2400, `second backoff ${sleeps[1]}`);
  });

  it("caps the backoff", async () => {
    const sleeps: number[] = [];
    await deliverCallback(event, {
      url: "http://backend/x", secret: SECRET, maxAttempts: 8, baseDelayMs: 1000, maxDelayMs: 4000,
      fetchImpl: (async () => respond(503)) as typeof fetch,
      sleep: async (ms) => { sleeps.push(ms); },
    });
    assert.ok(Math.max(...sleeps) <= 4000 * 1.2);
  });

  it("retries network errors", async () => {
    let calls = 0;
    const result = await deliverCallback(event, {
      url: "http://backend/x", secret: SECRET, maxAttempts: 3, ...noSleep,
      fetchImpl: (async () => {
        if (++calls < 3) throw new Error("ECONNREFUSED");
        return respond(204);
      }) as typeof fetch,
    });
    assert.equal(result.delivered, true);
    assert.equal(result.attempts, 3);
  });

  it("stops immediately on a non-retryable 4xx (e.g. bad signature)", async () => {
    let calls = 0;
    const result = await deliverCallback(event, {
      url: "http://backend/x", secret: SECRET, maxAttempts: 5, ...noSleep,
      fetchImpl: (async () => { calls++; return respond(401); }) as typeof fetch,
    });
    assert.equal(calls, 1);
    assert.equal(result.delivered, false);
    assert.equal(result.lastStatus, 401);
  });

  it("gives up after maxAttempts and reports failure", async () => {
    let calls = 0;
    const result = await deliverCallback(event, {
      url: "http://backend/x", secret: SECRET, maxAttempts: 4, ...noSleep,
      fetchImpl: (async () => { calls++; return respond(500); }) as typeof fetch,
    });
    assert.equal(calls, 4);
    assert.equal(result.delivered, false);
  });

  it("re-sends the identical body every attempt (paymentId is the idempotency key)", async () => {
    const bodies: string[] = [];
    await deliverCallback(event, {
      url: "http://backend/x", secret: SECRET, maxAttempts: 3, ...noSleep,
      fetchImpl: (async (_u: unknown, init?: RequestInit) => { bodies.push(String(init?.body)); return respond(503); }) as typeof fetch,
    });
    assert.equal(new Set(bodies).size, 1);
    assert.equal(bodies.length, 3);
  });

  it("classifies retryable statuses", () => {
    for (const s of [500, 502, 503, 408, 429]) assert.equal(isRetryableStatus(s), true);
    for (const s of [200, 400, 401, 403, 404, 409]) assert.equal(isRetryableStatus(s), false);
  });
});
