import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentSettledEvent } from "@inklink/shared-schemas";
import { createDevDevice } from "../src/scripts/dev-device.js";

process.env.HEDERA_AGENT_ACCOUNT_ID = "0.0.1001";
process.env.HEDERA_AGENT_PRIVATE_KEY = "not-used-in-these-tests";
process.env.MERCHANT_ACCOUNT_ID = "0.0.2002";
process.env.MERCHANT_ID = "shop_001";

type Discovery = typeof import("../src/gate-discovery.js");
type AgentModule = typeof import("../src/payment-agent.js");
let d: Discovery;
let mod: AgentModule;
before(async () => {
  d = await import("../src/gate-discovery.js");
  mod = await import("../src/payment-agent.js");
});

const GATE = "https://gate.example";
const TX = "0.0.7162784@1700000000.000000001";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function discoveryDoc(over: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) {
  return {
    x402Version: 2,
    items: [{
      resource: `${GATE}/api/v1/jobs/:jobId/execute`,
      type: "http",
      x402Version: 2,
      accepts: [],
      lastUpdated: "2026-11-06T10:00:00Z",
      tags: ["printing", "inklink", "print-job"],
      extensions: { inklink: { method: "POST", routeTemplate: "/api/v1/jobs/:jobId/execute", ...meta } },
      ...over,
    }],
    pagination: { limit: 1, offset: 0, total: 1 },
  };
}

function paymentRequired(amount: string, payTo = "0.0.2002", asset = "0.0.429274") {
  return encodePaymentRequiredHeader({
    x402Version: 2,
    resource: { url: `${GATE}/api/v1/jobs/job_1/execute`, description: "x", mimeType: "application/json" },
    accepts: [{ scheme: "exact", network: "hedera:testnet", asset, amount, payTo, maxTimeoutSeconds: 60, extra: {} }],
  } as never);
}

/** Fake gate: discovery document + an unpaid POST that answers 402 with `amount`. */
function fakeGate(amount: string, doc: unknown = discoveryDoc()) {
  const calls: string[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.endsWith("/discovery/resources")) return new Response(JSON.stringify(doc), { status: 200 });
    return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": paymentRequired(amount) } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("endpoint discovery", () => {
  it("finds the print-job endpoint for a job from the gate's x402 discovery document", async () => {
    const { impl } = fakeGate("100000");
    assert.equal(await d.discoverPrintJobEndpoint(GATE, "job/1", impl), `${GATE}/api/v1/jobs/job%2F1/execute`);
  });

  it("refuses listings that point at another host, lack the tag, or are not x402 v2", async () => {
    await assert.rejects(d.discoverPrintJobEndpoint(GATE, "j", fakeGate("1", discoveryDoc({ resource: "https://evil.example/api/v1/jobs/:jobId/execute" })).impl), /does not list/);
    await assert.rejects(d.discoverPrintJobEndpoint(GATE, "j", fakeGate("1", discoveryDoc({ tags: ["other"] })).impl), /does not list/);
    await assert.rejects(d.discoverPrintJobEndpoint(GATE, "j", fakeGate("1", discoveryDoc({}, { method: "GET" })).impl), /does not list/);
    await assert.rejects(d.discoverPrintJobEndpoint(GATE, "j", fakeGate("1", { ...discoveryDoc(), x402Version: 1 }).impl), /x402 v2/);
  });

  it("reads the price from the 402 PAYMENT-REQUIRED header without paying", async () => {
    const q = await d.quoteFromGate(`${GATE}/api/v1/jobs/job_1/execute`, fakeGate("100000").impl);
    assert.deepEqual(q, [{ scheme: "exact", network: "hedera:testnet", asset: "0.0.429274", amount: "100000", payTo: "0.0.2002" }]);
    const no402 = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    await assert.rejects(d.quoteFromGate(`${GATE}/x`, no402), /Expected 402/);
    const noHeader = (async () => new Response("{}", { status: 402 })) as unknown as typeof fetch;
    await assert.rejects(d.quoteFromGate(`${GATE}/x`, noHeader), /PAYMENT-REQUIRED/);
  });

  it("the real gate publishes a document the agent can use", async () => {
    const { createX402Gate } = await import("../src/x402-gate.js");
    const { FixedRequirementsSource } = await import("../src/gate-requirements.js");
    const server = createX402Gate(new FixedRequirementsSource("0.10", "0.0.2002", 6)).listen(0);
    try {
      await new Promise<void>((r) => server.once("listening", () => r()));
      const port = (server.address() as { port: number }).port;
      const origin = `http://127.0.0.1:${port}`;
      const doc = await (await fetch(`${origin}/discovery/resources`)).json();
      assert.equal(doc.x402Version, 2);
      assert.ok(doc.items[0].extensions.bazaar, "carries the official x402 Bazaar extension");
      assert.equal(await d.discoverPrintJobEndpoint(origin, "job_9"), `${origin}/api/v1/jobs/job_9/execute`);
    } finally {
      server.close();
    }
  });
});

describe("agent uses discovery and reads the 402 price before signing", () => {
  const realFetch = globalThis.fetch;
  const mirrorOk = () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ transactions: [{
      result: "SUCCESS", consensus_timestamp: "1700000000.123456789",
      token_transfers: [
        { token_id: "0.0.429274", account: "0.0.1001", amount: -100000 },
        { token_id: "0.0.429274", account: "0.0.2002", amount: 100000 },
      ],
    }] }), { status: 200 })) as typeof fetch;
  };

  function setup(gateImpl: typeof fetch, discover = true) {
    let paid = 0;
    const x402 = {
      pay: () => {
        paid++;
        return Promise.resolve({ success: true, transaction: TX, network: "hedera:testnet" });
      },
    } as unknown as ConstructorParameters<AgentModule["PaymentAgent"]>[0];
    const delivered: PaymentSettledEvent[] = [];
    const agent = new mod.PaymentAgent(x402, {
      allowedResourceOrigins: [GATE],
      payerAccountId: "0.0.1001",
      verification: { attempts: 2, delayMs: 5 },
      gate: { discoveryOrigin: discover ? GATE : undefined, probePrice: true, fetchImpl: gateImpl },
      deliver: async (e) => {
        delivered.push(e);
        return { delivered: true, attempts: 1 };
      },
    });
    return { agent, paid: () => paid };
  }

  const device = createDevDevice();
  const authorize = (agent: InstanceType<AgentModule["PaymentAgent"]>) =>
    agent.authorize(device.signAuthorization({
      agentId: "inklink_payment_agent", merchantId: "shop_001", maxPerTransaction: "1.00",
      totalSpendingLimit: "5.00", asset: "USDC", expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    }));
  const req = (authorizationId: string, jobId: string, resourceUrl?: string) => ({
    jobId, quoteId: "quote_1", authorizationId, paymentMethod: "hedera_x402" as const, merchantId: "shop_001",
    settlementAmount: "0.10", quoteExpiresAt: new Date(Date.now() + 300_000).toISOString(),
    ...(resourceUrl ? { resourceUrl } : {}),
  });

  it("finds the endpoint itself, checks the 402 price, then pays", async () => {
    mirrorOk();
    try {
      const gate = fakeGate("100000");
      const { agent, paid } = setup(gate.impl);
      const p = await agent.initiate(req(authorize(agent).authorizationId, "job_disc"));
      await sleep(100);
      const rec = agent.inspect(p.paymentId);
      assert.equal(rec?.status, "settled");
      assert.equal(rec?.gateQuote?.amount, "100000");
      assert.equal(rec?.gateQuote?.resourceUrl, `${GATE}/api/v1/jobs/job_disc/execute`);
      assert.equal(paid(), 1);
      assert.deepEqual(gate.calls, [`GET ${GATE}/discovery/resources`, `POST ${GATE}/api/v1/jobs/job_disc/execute`]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("refuses to sign when the 402 price differs from the authorized amount, and releases the spend", async () => {
    const { agent, paid } = setup(fakeGate("110000").impl);
    const auth = authorize(agent);
    const p = await agent.initiate(req(auth.authorizationId, "job_overcharge"));
    await sleep(50);
    const rec = agent.inspect(p.paymentId);
    assert.equal(rec?.status, "failed");
    assert.match(rec?.failureReason ?? "", /gate_price_mismatch/);
    assert.equal(rec?.fundsMayHaveMoved, false);
    assert.equal(paid(), 0, "nothing signed");
    const { authStore } = await import("../src/store.js");
    assert.equal(Number(authStore.get(auth.authorizationId)?.spentToDate), 0, "reserved spend was released");
  });

  it("refuses a caller-supplied URL that differs from the discovered endpoint", async () => {
    const { agent } = setup(fakeGate("100000").impl);
    await assert.rejects(
      agent.initiate(req(authorize(agent).authorizationId, "job_x", `${GATE}/api/v1/jobs/job_other/execute`)),
      /differs from the endpoint/,
    );
  });

  it("without discovery it still needs a resourceUrl", async () => {
    const { agent } = setup(fakeGate("100000").impl, false);
    await assert.rejects(agent.initiate(req(authorize(agent).authorizationId, "job_y")), /No resourceUrl/);
  });
});
