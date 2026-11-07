/**
 * Resolving a payment whose settlement response was lost. The agent signed a transfer but never
 * got the tx id back (connection dropped), so the spend is kept and the payment is "funds may
 * have moved". recover() then searches the mirror node for the matching transfer and either
 * adopts it (settles) or, once the signing window has passed with nothing found, releases the
 * spend. It must never adopt an unrelated transfer and never double-pay.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDevDevice } from "../src/scripts/dev-device.js";

process.env.HEDERA_AGENT_ACCOUNT_ID = "0.0.1001";
process.env.HEDERA_AGENT_PRIVATE_KEY = "not-used-in-these-tests";
process.env.MERCHANT_ACCOUNT_ID = "0.0.2002";
process.env.MERCHANT_ID = "shop_001";

type AgentModule = typeof import("../src/payment-agent.js");
type StoreModule = typeof import("../src/store.js");
type SettlementModule = typeof import("../src/settlement.js");
let mod: AgentModule;
let store: StoreModule;
let settlement: SettlementModule;
before(async () => {
  mod = await import("../src/payment-agent.js");
  store = await import("../src/store.js");
  settlement = await import("../src/settlement.js");
});

const GATE = "https://gate.example";
const PAYER = "0.0.1001";
const PAYTO = "0.0.2002";
const USDC = "0.0.429274";
const TX = "0.0.7162784@1794008511.539597966";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const device = createDevDevice();

/** Mirror responses: the CRYPTOTRANSFER search, then the by-id verification used by finalize. */
function mirror(opts: { search: unknown; verifyOk: boolean }) {
  return (async (url: string) => {
    if (url.includes("/transactions?")) return new Response(JSON.stringify(opts.search), { status: 200 });
    if (url.includes("/transactions/")) {
      return new Response(JSON.stringify({ transactions: opts.verifyOk ? [{
        result: "SUCCESS", consensus_timestamp: "1794008511.600000000",
        token_transfers: [{ token_id: USDC, account: PAYTO, amount: 24000 }, { token_id: USDC, account: PAYER, amount: -24000 }],
      }] : [] }), { status: 200 });
    }
    throw new Error(`unexpected ${url}`);
  }) as unknown as typeof fetch;
}

const matchTx = {
  transactions: [{
    transaction_id: "0.0.7162784-1794008511-539597966", result: "SUCCESS", consensus_timestamp: "1794008511.600000000",
    token_transfers: [{ token_id: USDC, account: PAYTO, amount: 24000 }, { token_id: USDC, account: PAYER, amount: -24000 }],
  }],
  links: { next: null },
};

function agent(fetchImpl: typeof fetch) {
  const delivered: unknown[] = [];
  const a = new mod.PaymentAgent({ pay: async () => ({ success: true }) } as never, {
    allowedResourceOrigins: [GATE],
    payerAccountId: PAYER,
    verification: { attempts: 1, delayMs: 1 },
    gate: { fetchImpl },
    deliver: async (e) => { delivered.push(e); return { delivered: true, attempts: 1 }; },
  });
  return { a, delivered };
}

/** A payment stuck exactly as the lost-response path leaves it: failed, funds may have moved, no tx id. */
function stuckRecord(signedSecondsAgo: number) {
  return {
    paymentId: `payment_${Math.random().toString(16).slice(2, 10)}`,
    jobId: "job_lost", quoteId: "quote_1", authorizationId: "auth_1", merchantId: "shop_001",
    payTo: PAYTO, amount: "0.024", asset: "USDC", status: "failed" as const,
    paymentReference: "ref", transactionId: null, settlementTimestamp: null,
    failureReason: "Signed payment sent but the outcome is unknown: socket hang up",
    fundsMayHaveMoved: true, signedAtSeconds: Math.floor(Date.now() / 1000 - signedSecondsAgo).toString(),
    createdAt: new Date().toISOString(),
  };
}

describe("findTransferByPayer", () => {
  it("matches the exact transfer and returns the SDK-form tx id", async () => {
    const got = await settlement.findTransferByPayer(
      PAYER, { tokenId: USDC, payTo: PAYTO, amountAtomic: 24000n }, "1794008500", mirror({ search: matchTx, verifyOk: true }),
    );
    assert.equal(got?.transactionId, TX);
  });

  it("ignores transfers of a different amount or to a different account", async () => {
    const wrong = { transactions: [
      { transaction_id: "0.0.7.1-1-1", result: "SUCCESS", consensus_timestamp: "1.0", token_transfers: [{ token_id: USDC, account: PAYTO, amount: 23999 }] },
      { transaction_id: "0.0.7.2-2-2", result: "SUCCESS", consensus_timestamp: "2.0", token_transfers: [{ token_id: USDC, account: "0.0.9999", amount: 24000 }] },
    ], links: { next: null } };
    assert.equal(await settlement.findTransferByPayer(PAYER, { tokenId: USDC, payTo: PAYTO, amountAtomic: 24000n }, "0", mirror({ search: wrong, verifyOk: false })), null);
  });

  it("returns null (not an error) on a mirror network failure", async () => {
    const boom = (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
    assert.equal(await settlement.findTransferByPayer(PAYER, { tokenId: USDC, payTo: PAYTO, amountAtomic: 24000n }, "0", boom), null);
  });
});

describe("recover() resolves a lost-response payment", () => {
  it("adopts the on-chain transfer and settles it (spend kept, callback sent)", async () => {
    store.disablePersistence();
    // finalize()'s by-id verification uses the global fetch; the search uses the injected one.
    const realFetch = globalThis.fetch;
    globalThis.fetch = mirror({ search: matchTx, verifyOk: true });
    try {
      const { a, delivered } = agent(mirror({ search: matchTx, verifyOk: true }));
      const rec = stuckRecord(10);
      store.paymentStore.put(rec as never, `idem:${rec.paymentId}`);

      await a.recover();
      await sleep(20);
      const after = a.inspect(rec.paymentId);
      assert.equal(after?.status, "settled");
      assert.equal(after?.transactionId, TX);
      assert.equal(delivered.length, 1, "callback sent once");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("while still inside the window with nothing found, stays failed/funds-may-have-moved (does not release)", async () => {
    store.disablePersistence();
    const { a } = agent(mirror({ search: { transactions: [], links: { next: null } }, verifyOk: false }));
    const rec = stuckRecord(10); // signed 10 s ago, well inside the 5-min window
    store.paymentStore.put(rec as never, `idem:${rec.paymentId}`);

    await a.recover();
    const after = a.inspect(rec.paymentId);
    assert.equal(after?.status, "failed");
    assert.equal(after?.fundsMayHaveMoved, true, "spend still kept");
    assert.equal(after?.transactionId, null);
  });

  it("once the window has fully passed with nothing found, releases the spend", async () => {
    store.disablePersistence();
    const { a } = agent(mirror({ search: { transactions: [], links: { next: null } }, verifyOk: false }));
    const rec = stuckRecord(10 * 60); // signed 10 min ago, past the 5-min window
    store.paymentStore.put(rec as never, `idem:${rec.paymentId}`);

    await a.recover();
    const after = a.inspect(rec.paymentId);
    assert.equal(after?.status, "failed");
    assert.equal(after?.fundsMayHaveMoved, false, "spend released");
    assert.equal(after?.failureReason, "no_settlement_found_after_signing_window");
  });
});
