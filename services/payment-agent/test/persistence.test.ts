import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PaymentSettledEvent } from "@inklink/shared-schemas";
import { createDevDevice } from "../src/scripts/dev-device.js";

process.env.HEDERA_AGENT_ACCOUNT_ID = "0.0.1001";
process.env.HEDERA_AGENT_PRIVATE_KEY = "not-used-in-these-tests";
process.env.MERCHANT_ACCOUNT_ID = "0.0.2002";
process.env.MERCHANT_ID = "shop_001";

type AgentModule = typeof import("../src/payment-agent.js");
type StoreModule = typeof import("../src/store.js");
let agentMod: AgentModule;
let store: StoreModule;
let dir: string;
let file: string;

before(async () => {
  agentMod = await import("../src/payment-agent.js");
  store = await import("../src/store.js");
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "inklink-state-"));
});

after(() => {
  store.disablePersistence();
  fs.rmSync(dir, { recursive: true, force: true });
});

let n = 0;
beforeEach(() => {
  store.disablePersistence();
  store.clearMemory();
  file = path.join(dir, `state-${++n}.json`);
});

const GATE = "http://localhost:4022";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TX = "0.0.7162784@1700000000.000000001";
const device = createDevDevice();

type Behaviour = "hang" | "settle";

function stubX402(behaviour: Behaviour) {
  return {
    pay: () =>
      behaviour === "hang"
        ? new Promise<never>(() => {})
        : Promise.resolve({ success: true, transaction: TX, network: "hedera:testnet" }),
  } as unknown as ConstructorParameters<AgentModule["PaymentAgent"]>[0];
}

function makeAgent(behaviour: Behaviour) {
  const delivered: PaymentSettledEvent[] = [];
  const agent = new agentMod.PaymentAgent(stubX402(behaviour), {
    allowedResourceOrigins: [GATE],
    payerAccountId: "0.0.1001",
    verification: { attempts: 2, delayMs: 5 },
    deliver: async (event) => {
      delivered.push(event);
      return { delivered: true, attempts: 1 };
    },
  });
  return { agent, delivered };
}

const signed = (max = "1.00", total = "1.00") =>
  device.signAuthorization({
    agentId: "inklink_payment_agent",
    merchantId: "shop_001",
    maxPerTransaction: max,
    totalSpendingLimit: total,
    asset: "USDC",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });

const initiateReq = (authorizationId: string, jobId: string, amount = "0.60") => ({
  jobId,
  quoteId: "quote_1",
  authorizationId,
  paymentMethod: "hedera_x402" as const,
  merchantId: "shop_001",
  settlementAmount: amount,
  resourceUrl: `${GATE}/api/v1/jobs/${jobId}/execute`,
  quoteExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
});

/** Simulates a process restart: memory is lost, state is reloaded from disk. */
function restart() {
  store.clearMemory();
  return store.enablePersistence(file);
}

const mirror = (transactions: unknown[]) => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ transactions }), { status: 200 })) as typeof fetch;
};
const matchingTx = [
  {
    result: "SUCCESS",
    consensus_timestamp: "1700000000.123456789",
    token_transfers: [
      { token_id: "0.0.429274", account: "0.0.1001", amount: -600000 },
      { token_id: "0.0.429274", account: "0.0.2002", amount: 600000 },
    ],
  },
];

const record = (over: Partial<import("../src/store.js").PaymentRecord>) => ({
  paymentId: "payment_x",
  jobId: "job_x",
  quoteId: "quote_1",
  authorizationId: "auth_x",
  merchantId: "shop_001",
  payTo: "0.0.2002",
  amount: "0.60",
  asset: "USDC",
  status: "processing" as const,
  paymentReference: "ref",
  transactionId: null,
  settlementTimestamp: null,
  createdAt: new Date().toISOString(),
  ...over,
});

describe("durable state", () => {
  it("survives a restart: spent limit, nonces and idempotency keys", async () => {
    store.enablePersistence(file);
    const { agent } = makeAgent("hang");
    const req = signed();
    const auth = agent.authorize(req);
    const p = await agent.initiate(initiateReq(auth.authorizationId, "job_a"));
    assert.equal(p.status, "processing");

    assert.equal(restart().loaded, true);
    const { agent: after } = makeAgent("hang");

    // The 0.60 reservation is still counted.
    assert.equal(store.authStore.get(auth.authorizationId)?.spentToDate, "0.600000");
    await assert.rejects(after.initiate(initiateReq(auth.authorizationId, "job_b")), /EXCEEDS_TOTAL_LIMIT/);
    // Same payment request: same payment, not a second one.
    assert.equal((await after.initiate(initiateReq(auth.authorizationId, "job_a"))).paymentId, p.paymentId);
    // Same signed authorization: idempotent. Same nonce with different content: replay.
    assert.equal(after.authorize(req).authorizationId, auth.authorizationId);
    const reused = device.signAuthorization({
      agentId: "inklink_payment_agent", merchantId: "shop_001", maxPerTransaction: "9.00",
      totalSpendingLimit: "50.00", asset: "USDC", expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      nonce: req.nonce,
    });
    assert.throws(() => after.authorize(reused), /already used/);
  });

  it("writes atomically: valid versioned JSON and no temp file left behind", () => {
    store.enablePersistence(file);
    makeAgent("hang").agent.authorize(signed());
    assert.equal(fs.existsSync(`${file}.tmp`), false);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).version, 1);
  });

  it("refuses to start on a corrupt file and leaves it untouched", () => {
    for (const bad of ["{ not json", JSON.stringify({ version: 2 }), JSON.stringify({ version: 1, payments: [] })]) {
      fs.writeFileSync(file, bad);
      assert.throws(() => store.enablePersistence(file), /corrupt/);
      assert.equal(fs.readFileSync(file, "utf8"), bad);
    }
  });

  it("creates the file (and parent directory) when none exists, and fails if it cannot", () => {
    const nested = path.join(dir, "a", "b", "state.json");
    assert.deepEqual(store.enablePersistence(nested), { loaded: false });
    assert.equal(fs.existsSync(nested), true);
    store.disablePersistence();
    // A directory where the file should be is not writable as a file.
    const blocked = path.join(dir, "blocked.json");
    fs.mkdirSync(blocked);
    assert.throws(() => store.enablePersistence(blocked));
  });
});

describe("recover()", () => {
  const realFetch = globalThis.fetch;
  after(() => {
    globalThis.fetch = realFetch;
  });

  it("an in-flight payment with no transaction id is outcome-unknown: failed, but spend KEPT", async () => {
    store.enablePersistence(file);
    const { agent } = makeAgent("hang");
    const auth = agent.authorize(signed());
    const p = await agent.initiate(initiateReq(auth.authorizationId, "job_a"));

    restart();
    const { agent: after } = makeAgent("hang");
    const summary = await after.recover();

    assert.deepEqual(summary, { reverified: 0, outcomeUnknown: 1, callbacksResent: 0 });
    assert.equal(after.status(p.paymentId)?.status, "failed");
    assert.equal(after.inspect(p.paymentId)?.failureReason, "interrupted_by_restart_outcome_unknown");
    // Funds may have moved, so the 0.60 must stay reserved.
    await assert.rejects(after.initiate(initiateReq(auth.authorizationId, "job_b")), /EXCEEDS_TOTAL_LIMIT/);
  });

  it("an in-flight payment WITH a claimed transaction is re-verified, settled and called back", async () => {
    store.enablePersistence(file);
    const { agent } = makeAgent("hang");
    const auth = agent.authorize(signed());
    const p = await agent.initiate(initiateReq(auth.authorizationId, "job_a"));
    store.paymentStore.update(p.paymentId, { transactionId: TX });

    restart();
    mirror(matchingTx);
    const { agent: after, delivered } = makeAgent("hang");
    const summary = await after.recover();
    await sleep(30);

    assert.equal(summary.reverified, 1);
    assert.equal(after.status(p.paymentId)?.status, "settled");
    assert.equal(after.status(p.paymentId)?.transactionId, TX);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].paymentId, p.paymentId);
    assert.equal(delivered[0].merchantAccountId, "0.0.2002");
    assert.equal(after.inspect(p.paymentId)?.callbackStatus, "delivered");
  });

  it("a payment marked 'unverified' is settled once the mirror node catches up", async () => {
    store.enablePersistence(file);
    mirror([]); // the mirror node does not see the transfer yet
    const { agent } = makeAgent("settle");
    const auth = agent.authorize(signed());
    const p = await agent.initiate(initiateReq(auth.authorizationId, "job_a"));
    await sleep(80);
    assert.equal(agent.inspect(p.paymentId)?.failureReason, "settlement_unverified_on_mirror_node");
    assert.equal(agent.status(p.paymentId)?.transactionId, null);

    restart();
    mirror(matchingTx); // now it does
    const { agent: after, delivered } = makeAgent("hang");
    const summary = await after.recover();
    await sleep(30);

    assert.equal(summary.reverified, 1);
    assert.equal(after.status(p.paymentId)?.status, "settled");
    assert.equal(after.inspect(p.paymentId)?.failureReason, undefined);
    assert.equal(delivered.length, 1);
  });

  it("resends the stored callback for undelivered settlements only", async () => {
    store.enablePersistence(file);
    const event = (id: string): PaymentSettledEvent => ({
      paymentId: id, jobId: `job_${id}`, payerAccount: "0.0.1001", merchantAccountId: "0.0.2002",
      network: "hedera:testnet", asset: "HTS_USDC", amount: "0.60", transactionId: TX,
      settlementTimestamp: "2023-11-14T22:13:20.123Z", status: "settled", hashscanUrl: "https://hashscan.io/testnet/transaction/x",
    });
    for (const [id, cb] of [["pending", "pending"], ["failed", "failed"], ["delivered", "delivered"]] as const) {
      store.paymentStore.put(
        record({ paymentId: id, jobId: `job_${id}`, status: "settled", transactionId: TX, callbackStatus: cb, event: event(id) }),
        `k-${id}`,
      );
    }

    restart();
    const { agent, delivered } = makeAgent("hang");
    const summary = await agent.recover();

    assert.equal(summary.callbacksResent, 2);
    assert.deepEqual(delivered.map((e) => e.paymentId).sort(), ["failed", "pending"]);
    assert.equal(agent.inspect("delivered")?.callbackStatus, "delivered");
    assert.equal(agent.inspect("pending")?.callbackStatus, "delivered");
  });

  it("does nothing for a clean state", async () => {
    store.enablePersistence(file);
    const { agent, delivered } = makeAgent("hang");
    assert.deepEqual(await agent.recover(), { reverified: 0, outcomeUnknown: 0, callbacksResent: 0 });
    assert.equal(delivered.length, 0);
  });
});

describe("mirror-node network errors", () => {
  const realFetch = globalThis.fetch;
  after(() => {
    globalThis.fetch = realFetch;
  });

  it("never release the spend: a transfer that could not be confirmed may have happened", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNRESET");
    }) as typeof fetch;
    const { agent, delivered } = makeAgent("settle");
    const auth = agent.authorize(signed());
    const p = await agent.initiate(initiateReq(auth.authorizationId, "job_a"));
    await sleep(80);

    assert.equal(agent.status(p.paymentId)?.status, "failed");
    assert.equal(agent.inspect(p.paymentId)?.failureReason, "settlement_unverified_on_mirror_node");
    assert.equal(agent.inspect(p.paymentId)?.transactionId, TX);
    assert.equal(delivered.length, 0);
    await assert.rejects(agent.initiate(initiateReq(auth.authorizationId, "job_b")), /EXCEEDS_TOTAL_LIMIT/);
  });
});
