/**
 * Money safety under concurrency and uncertain outcomes:
 *  - two payments on one authorization cannot together exceed its total limit,
 *  - a retried request (same job, quote, authorization) never pays twice,
 *  - once a signed transfer has been sent, an error keeps the spend (funds may have moved).
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDevDevice } from "../src/scripts/dev-device.js";

process.env.HEDERA_AGENT_ACCOUNT_ID = "0.0.1001";
process.env.HEDERA_AGENT_PRIVATE_KEY = "not-used-in-these-tests";
process.env.MERCHANT_ACCOUNT_ID = "0.0.2002";
process.env.MERCHANT_ID = "shop_001";

type AgentModule = typeof import("../src/payment-agent.js");
type ClientModule = typeof import("../src/x402-client.js");
type StoreModule = typeof import("../src/store.js");
let mod: AgentModule;
let client: ClientModule;
let store: StoreModule;
before(async () => {
  mod = await import("../src/payment-agent.js");
  client = await import("../src/x402-client.js");
  store = await import("../src/store.js");
});

const GATE = "https://gate.example";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const device = createDevDevice();

/** Discovery that answers after a delay, so concurrent requests really overlap the await. */
function slowDiscovery(delayMs = 30) {
  return (async (url: string) => {
    await sleep(delayMs);
    if (!url.endsWith("/discovery/resources")) throw new Error(`unexpected ${url}`);
    return new Response(JSON.stringify({
      x402Version: 2,
      items: [{
        resource: `${GATE}/api/v1/jobs/:jobId/execute`, type: "http", x402Version: 2, accepts: [],
        lastUpdated: "2026-11-06T10:00:00Z", tags: ["printing", "inklink", "print-job"],
        extensions: { inklink: { method: "POST", routeTemplate: "/api/v1/jobs/:jobId/execute" } },
      }],
      pagination: { limit: 1, offset: 0, total: 1 },
    }), { status: 200 });
  }) as unknown as typeof fetch;
}

function agentWith(pay: () => Promise<unknown>) {
  let calls = 0;
  const x402 = {
    pay: () => {
      calls++;
      return pay();
    },
  } as unknown as ConstructorParameters<AgentModule["PaymentAgent"]>[0];
  const agent = new mod.PaymentAgent(x402, {
    allowedResourceOrigins: [GATE],
    payerAccountId: "0.0.1001",
    verification: { attempts: 1, delayMs: 1 },
    gate: { discoveryOrigin: GATE, probePrice: false, fetchImpl: slowDiscovery() },
    deliver: async () => ({ delivered: true, attempts: 1 }),
  });
  return { agent, calls: () => calls };
}

const authorize = (agent: InstanceType<AgentModule["PaymentAgent"]>, max: string, total: string) =>
  agent.authorize(device.signAuthorization({
    agentId: "inklink_payment_agent", merchantId: "shop_001", maxPerTransaction: max,
    totalSpendingLimit: total, asset: "USDC", expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  }));

const req = (authorizationId: string, jobId: string, amount: string, quoteId = "quote_1") => ({
  jobId, quoteId, authorizationId, paymentMethod: "hedera_x402" as const, merchantId: "shop_001",
  settlementAmount: amount, quoteExpiresAt: new Date(Date.now() + 300_000).toISOString(),
});

const never = () => new Promise<never>(() => {}); // settlement still in flight

describe("concurrent payments on one authorization", () => {
  it("cannot together exceed the total limit (no stale spentToDate across the discovery await)", async () => {
    const { agent, calls } = agentWith(never);
    const auth = authorize(agent, "0.60", "1.00");

    const results = await Promise.allSettled([
      agent.initiate(req(auth.authorizationId, "job_a", "0.60")),
      agent.initiate(req(auth.authorizationId, "job_b", "0.60")),
    ]);

    const ok = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    assert.equal(ok.length, 1, "exactly one payment may start");
    assert.equal(refused.length, 1);
    assert.match(String(refused[0].reason?.message), /Policy violation/);
    assert.equal(store.authStore.get(auth.authorizationId)?.spentToDate, "0.600000", "the first reservation is kept intact");
    await sleep(5);
    assert.equal(calls(), 1, "only one transfer is signed");
  });

  it("a retried request (same job, quote and authorization) returns the same payment and pays once", async () => {
    const { agent, calls } = agentWith(never);
    const auth = authorize(agent, "1.00", "5.00");

    const [a, b] = await Promise.all([
      agent.initiate(req(auth.authorizationId, "job_retry", "0.10")),
      agent.initiate(req(auth.authorizationId, "job_retry", "0.10")),
    ]);
    assert.equal(a.paymentId, b.paymentId);
    await sleep(5);
    assert.equal(calls(), 1);
    assert.equal(store.authStore.get(auth.authorizationId)?.spentToDate, "0.100000", "reserved once");
  });
});

describe("a signed transfer with an unknown outcome", () => {
  it("keeps the spend reserved and marks that funds may have moved", async () => {
    const { agent } = agentWith(() =>
      Promise.reject(new client.PaymentOutcomeUnknownError("Signed payment sent but the outcome is unknown: socket hang up")),
    );
    const auth = authorize(agent, "1.00", "5.00");
    const p = await agent.initiate(req(auth.authorizationId, "job_dropped", "0.25"));
    await sleep(20);

    const rec = agent.inspect(p.paymentId);
    assert.equal(rec?.status, "failed");
    assert.equal(rec?.fundsMayHaveMoved, true);
    assert.equal(store.authStore.get(auth.authorizationId)?.spentToDate, "0.250000", "spend NOT released");
  });

  it("an error before anything was signed still releases the spend", async () => {
    const { agent } = agentWith(() => Promise.reject(new Error("402 had no acceptable payment option")));
    const auth = authorize(agent, "1.00", "5.00");
    const p = await agent.initiate(req(auth.authorizationId, "job_unsigned", "0.25"));
    await sleep(20);

    assert.equal(agent.inspect(p.paymentId)?.fundsMayHaveMoved, false);
    assert.equal(Number(store.authStore.get(auth.authorizationId)?.spentToDate), 0);
  });
});

describe("X402Client tells a signed-and-sent payment apart from one never signed", () => {
  const constraints = { payTo: "0.0.2002", amount: "0.10" };
  /** Fake signing service: `signs` decides whether the x402 flow reached signing. */
  const factory = (signs: boolean, respond: () => Promise<Response>) => ({
    payingFetch: (_c: unknown, onSigned?: () => void) =>
      (async () => {
        if (signs) onSigned?.();
        return respond();
      }) as unknown as typeof fetch,
  });
  const settledHeader = (body: object) => Buffer.from(JSON.stringify(body)).toString("base64");

  it("a dropped connection after signing is an unknown outcome", async () => {
    const c = new client.X402Client(factory(true, () => Promise.reject(new Error("socket hang up"))));
    await assert.rejects(c.pay(`${GATE}/x`, constraints), client.PaymentOutcomeUnknownError);
  });

  it("an error status without a settlement answer after signing is an unknown outcome", async () => {
    const c = new client.X402Client(factory(true, async () => new Response("upstream timeout", { status: 504 })));
    await assert.rejects(c.pay(`${GATE}/x`, constraints), (e: unknown) =>
      e instanceof client.PaymentOutcomeUnknownError && /HTTP 504/.test((e as Error).message));
  });

  it("a failure before signing is an ordinary error (nothing sent)", async () => {
    const c = new client.X402Client(factory(false, () => Promise.reject(new Error("ECONNREFUSED"))));
    await assert.rejects(c.pay(`${GATE}/x`, constraints), (e: unknown) =>
      !(e instanceof client.PaymentOutcomeUnknownError) && /ECONNREFUSED/.test((e as Error).message));
  });

  it("an explicit facilitator refusal is returned as a settlement answer, even on an error status", async () => {
    const header = settledHeader({ success: false, errorReason: "insufficient_funds", transaction: "", network: "hedera:testnet" });
    const c = new client.X402Client(factory(true, async () =>
      new Response("{}", { status: 402, headers: { "PAYMENT-RESPONSE": header } })));
    const s = await c.pay(`${GATE}/x`, constraints);
    assert.equal(s.success, false);
    assert.equal(s.errorReason, "insufficient_funds");
  });
});
