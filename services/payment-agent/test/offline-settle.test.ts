import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PaymentSettledEvent } from "@inklink/shared-schemas";
import { createDevDevice } from "../src/scripts/dev-device.js";

process.env.HEDERA_AGENT_ACCOUNT_ID = "0.0.1001";
process.env.HEDERA_AGENT_PRIVATE_KEY = "not-used-in-these-tests";
process.env.MERCHANT_ACCOUNT_ID = "0.0.2002";
process.env.MERCHANT_ID = "shop_001";

type AgentModule = typeof import("../src/payment-agent.js");
type OfflineModule = typeof import("../src/offline-settlement.js");
type Schemas = typeof import("@inklink/shared-schemas");
let mod: AgentModule;
let off: OfflineModule;
let schemas: Schemas;
before(async () => {
  mod = await import("../src/payment-agent.js");
  off = await import("../src/offline-settlement.js");
  schemas = await import("@inklink/shared-schemas");
});

const GATE = "http://localhost:4022";
const TX = "0.0.7162784@1700000000.000000001";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const realFetch = globalThis.fetch;

/** Mirror node that confirms `amountAtomic` to 0.0.2002, or nothing at all. */
function mirror(amountAtomic: number | null) {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        transactions: amountAtomic === null ? [] : [{
          result: "SUCCESS",
          consensus_timestamp: "1700000000.123456789",
          token_transfers: [
            { token_id: "0.0.429274", account: "0.0.1001", amount: -amountAtomic },
            { token_id: "0.0.429274", account: "0.0.2002", amount: amountAtomic },
          ],
        }],
      }),
      { status: 200 },
    )) as typeof fetch;
}

type Mode = "settle" | "reject" | "hang";

function setup(mode: { value: Mode } = { value: "settle" }) {
  const calls: unknown[] = [];
  const x402 = {
    pay: (...args: unknown[]) => {
      calls.push(args);
      if (mode.value === "hang") return new Promise<never>(() => {});
      if (mode.value === "reject") return Promise.resolve({ success: false, errorReason: "stub_rejected", transaction: "", network: "hedera:testnet" });
      return Promise.resolve({ success: true, transaction: TX, network: "hedera:testnet" });
    },
  } as unknown as ConstructorParameters<AgentModule["PaymentAgent"]>[0];
  const delivered: PaymentSettledEvent[] = [];
  const agent = new mod.PaymentAgent(x402, {
    allowedResourceOrigins: [GATE],
    payerAccountId: "0.0.1001",
    verification: { attempts: 2, delayMs: 5 },
    deliver: async (e) => {
      delivered.push(e);
      return { delivered: true, attempts: 1 };
    },
  });
  const ledger = new schemas.OfflineLedger({ verify: off.nodeEd25519Verify });
  const offline = new off.OfflineSettlement(agent, ledger);
  return { agent, ledger, offline, calls, delivered, mode };
}

let n = 0;
function request(device: ReturnType<typeof createDevDevice>, over: Record<string, unknown> = {}, voucherOver: Record<string, unknown> = {}) {
  n++;
  const jobId = `job_off_${n}`;
  const voucher = device.signOfflineVoucher({ jobId, quoteId: "quote_1", merchantId: "shop_001", amount: "0.10", ...voucherOver });
  return {
    paymentId: `pay_off_${n}`,
    jobId: voucher.jobId,
    quoteId: "quote_1",
    merchantId: "shop_001",
    settlementAmount: "0.10",
    resourceUrl: `${GATE}/api/v1/jobs/${voucher.jobId}/execute`,
    voucher,
    ...over,
  };
}

const code = (c: string) => (e: unknown) => (e as { code?: string }).code === c;

describe("offline voucher settlement on the agent", () => {
  it("settles a valid voucher through x402 with the backend's paymentId and marks it SETTLED", async () => {
    mirror(100000);
    try {
      const { agent, offline, delivered, calls } = setup();
      const device = createDevDevice();
      const req = request(device);
      const r = await offline.settle(req);
      assert.equal(r.paymentId, req.paymentId);
      assert.equal(r.voucherState, "PENDING_SETTLEMENT");
      await sleep(100);

      assert.equal(agent.status(req.paymentId)?.status, "settled");
      assert.equal(agent.status(req.paymentId)?.transactionId, TX);
      const v = offline.get(req.voucher.voucherId);
      assert.equal(v?.state, "SETTLED");
      assert.equal(v?.transactionId, TX);
      assert.equal(delivered.length, 1);
      assert.equal(delivered[0].paymentId, req.paymentId, "callback carries the backend's paymentId");
      assert.equal(calls.length, 1);

      // Same request again: idempotent, never a second payment.
      const again = await offline.settle(req);
      assert.equal(again.voucherState, "SETTLED");
      assert.equal(calls.length, 1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("refuses a voucher that does not match the request, without recording it", async () => {
    const { offline, ledger, calls } = setup({ value: "hang" });
    const device = createDevDevice();
    for (const [over, msg] of [
      [{ settlementAmount: "0.11" }, /amount/],
      [{ quoteId: "quote_other" }, /quote/],
      [{ merchantId: "shop_002" }, /merchant/],
    ] as const) {
      await assert.rejects(offline.settle(request(device, over)), (e: unknown) => code("VOUCHER_MISMATCH")(e) && msg.test(String((e as Error).message)));
    }
    const wrongJob = request(device);
    await assert.rejects(offline.settle({ ...wrongJob, jobId: "job_x", resourceUrl: `${GATE}/api/v1/jobs/job_x/execute` }), code("VOUCHER_MISMATCH"));
    assert.equal(ledger.list().length, 0);
    assert.equal(calls.length, 0);
  });

  it("refuses a tampered or forged voucher", async () => {
    const { offline } = setup({ value: "hang" });
    const device = createDevDevice();
    const req = request(device);
    await assert.rejects(offline.settle({ ...req, voucher: { ...req.voucher, amount: "0.01" }, settlementAmount: "0.01" }), code("SIGNATURE_INVALID"));
    const other = createDevDevice();
    const forged = { ...req.voucher, signature: request(other).voucher.signature };
    await assert.rejects(offline.settle({ ...req, voucher: forged }), code("SIGNATURE_INVALID"));
    await assert.rejects(offline.settle({ ...req, paymentId: "bad id!" }), code("POLICY_VIOLATION"));
  });

  it("settles a voucher after it stopped being acceptable offline, within the settlement window only", async () => {
    const { offline } = setup({ value: "hang" });
    const device = createDevDevice();
    const issued = new Date(Date.now() - 2 * 60 * 60_000);
    const late = request(device, {}, { issuedAt: issued, validForMs: 30 * 60_000 });
    assert.equal((await offline.settle(late)).voucherState, "PENDING_SETTLEMENT");

    const ancient = request(device, {}, { issuedAt: new Date(Date.now() - (off.SETTLE_GRACE_MS + 60 * 60_000)), validForMs: 30 * 60_000 });
    await assert.rejects(offline.settle(ancient), code("VOUCHER_TOO_OLD"));
  });

  it("enforces the agent's own per-device unsettled limit", async () => {
    const { offline } = setup({ value: "hang" });
    const device = createDevDevice();
    const big = () => request(device, { settlementAmount: "2.00" }, { amount: "2.00" });
    await offline.settle(big());
    await offline.settle(big());
    await assert.rejects(offline.settle(big()), code("OVER_OUTSTANDING_LIMIT"));
  });

  it("a facilitator refusal marks the voucher failed; a retry needs a new paymentId and then settles", async () => {
    mirror(100000);
    try {
      const mode = { value: "reject" as Mode };
      const { agent, offline, calls } = setup(mode);
      const device = createDevDevice();
      const req = request(device);
      await offline.settle(req);
      await sleep(50);
      assert.equal(agent.status(req.paymentId)?.status, "failed");
      assert.equal(offline.get(req.voucher.voucherId)?.state, "SETTLEMENT_FAILED");

      await assert.rejects(offline.settle(req), code("PAYMENT_ID_CONFLICT"));
      mode.value = "settle";
      const retry = await offline.settle({ ...req, paymentId: `${req.paymentId}_r1` });
      assert.equal(retry.voucherState, "PENDING_SETTLEMENT");
      await sleep(100);
      assert.equal(offline.get(req.voucher.voucherId)?.state, "SETTLED");
      assert.equal(offline.get(req.voucher.voucherId)?.settlementAttempts, 2);
      assert.equal(calls.length, 2);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("never retries a voucher whose funds may have moved (unverified on the mirror node)", async () => {
    mirror(null);
    try {
      const { agent, offline, calls } = setup();
      const device = createDevDevice();
      const req = request(device);
      await offline.settle(req);
      await sleep(100);
      assert.equal(agent.status(req.paymentId)?.status, "failed");
      assert.equal(agent.inspect(req.paymentId)?.fundsMayHaveMoved, true);
      assert.equal(offline.get(req.voucher.voucherId)?.state, "PENDING_SETTLEMENT", "outcome unknown: not failed");
      await assert.rejects(offline.settle({ ...req, paymentId: `${req.paymentId}_r1` }), code("VOUCHER_SETTLEMENT_IN_PROGRESS"));
      assert.equal(calls.length, 1, "no second payment");

      // Later the mirror node confirms it (e.g. lag); recovery re-verifies and the voucher settles.
      mirror(100000);
      await agent.recover();
      offline.syncAll();
      assert.equal(agent.status(req.paymentId)?.status, "settled");
      assert.equal(offline.get(req.voucher.voucherId)?.state, "SETTLED");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("refuses a resource outside the allowed gate and leaves the voucher retryable", async () => {
    const { offline } = setup({ value: "hang" });
    const device = createDevDevice();
    const req = request(device);
    await assert.rejects(offline.settle({ ...req, resourceUrl: "https://evil.example/api/v1/jobs/x/execute" }), code("RESOURCE_NOT_ALLOWED"));
    assert.equal(offline.get(req.voucher.voucherId)?.state, "SETTLEMENT_FAILED");
    assert.equal((await offline.settle({ ...req, paymentId: `${req.paymentId}_r1` })).voucherState, "PENDING_SETTLEMENT");
  });
});
