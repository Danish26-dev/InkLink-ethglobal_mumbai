import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PaymentSettledEvent } from "@inklink/shared-schemas";
import { createDevDevice } from "../src/scripts/dev-device.js";

// Config is read lazily, so set env before the modules under test load it.
process.env.HEDERA_AGENT_ACCOUNT_ID = "0.0.1001";
process.env.HEDERA_AGENT_PRIVATE_KEY = "not-used-in-these-tests";
process.env.MERCHANT_ACCOUNT_ID = "0.0.2002";
process.env.MERCHANT_ID = "shop_001";

type AgentModule = typeof import("../src/payment-agent.js");
let mod: AgentModule;
before(async () => {
  mod = await import("../src/payment-agent.js");
});

const GATE = "http://localhost:4022";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Behaviour = "hang" | "reject" | "settle";

/** Stub x402 client: no network, no signing. */
function stubX402(behaviour: Behaviour) {
  return {
    pay: () => {
      if (behaviour === "hang") return new Promise<never>(() => {});
      if (behaviour === "reject") {
        return Promise.resolve({
          success: false, errorReason: "stub_rejected", transaction: "", network: "hedera:testnet",
        });
      }
      return Promise.resolve({
        success: true, transaction: "0.0.7162784@1700000000.000000001", network: "hedera:testnet",
      });
    },
  } as unknown as ConstructorParameters<AgentModule["PaymentAgent"]>[0];
}

function makeAgent(behaviour: Behaviour) {
  const delivered: PaymentSettledEvent[] = [];
  const agent = new mod.PaymentAgent(stubX402(behaviour), {
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

type Agent = ReturnType<typeof makeAgent>["agent"];
const device = createDevDevice();

function authorize(agent: Agent, max = "1.00", total = "5.00", merchantId = "shop_001") {
  return agent.authorize(
    device.signAuthorization({
      agentId: "inklink_payment_agent",
      merchantId,
      maxPerTransaction: max,
      totalSpendingLimit: total,
      asset: "USDC",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    }),
  );
}

const initiateReq = (
  authorizationId: string,
  jobId = "job_1",
  amount = "0.10",
  over: Record<string, unknown> = {},
) => ({
  jobId,
  quoteId: "quote_1",
  authorizationId,
  paymentMethod: "hedera_x402" as const,
  merchantId: "shop_001",
  settlementAmount: amount,
  resourceUrl: `${GATE}/api/v1/jobs/${jobId}/execute`,
  ...over,
});

describe("authorize (device-key signature)", () => {
  it("activates a policy only for a valid Ed25519 signature", () => {
    const { agent } = makeAgent("hang");
    const res = authorize(agent);
    assert.equal(res.status, "active");
    assert.match(res.authorizationId, /^auth_/);
  });

  it("rejects a tampered request (limit raised after signing)", () => {
    const { agent } = makeAgent("hang");
    const signed = device.signAuthorization({
      agentId: "inklink_payment_agent", merchantId: "shop_001",
      maxPerTransaction: "1.00", totalSpendingLimit: "5.00", asset: "USDC",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    assert.throws(
      () => agent.authorize({ ...signed, totalSpendingLimit: "500.00" }),
      /BAD_SIGNATURE/,
    );
  });

  it("rejects a signature from a different key than the claimed customerReference", () => {
    const { agent } = makeAgent("hang");
    const other = createDevDevice();
    const signed = other.signAuthorization({
      agentId: "inklink_payment_agent", merchantId: "shop_001",
      maxPerTransaction: "1.00", totalSpendingLimit: "5.00", asset: "USDC",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    assert.throws(
      () => agent.authorize({ ...signed, customerReference: device.customerReference }),
      /CUSTOMER_REFERENCE_MISMATCH/,
    );
  });

  it("rejects an authorization for a different agent", () => {
    const { agent } = makeAgent("hang");
    const signed = device.signAuthorization({
      agentId: "someone_else", merchantId: "shop_001",
      maxPerTransaction: "1.00", totalSpendingLimit: "5.00", asset: "USDC",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    assert.throws(() => agent.authorize(signed), /WRONG_AGENT/);
  });

  it("rejects expired and over-long authorizations", () => {
    const { agent } = makeAgent("hang");
    const base = {
      agentId: "inklink_payment_agent", merchantId: "shop_001",
      maxPerTransaction: "1.00", totalSpendingLimit: "5.00", asset: "USDC" as const,
    };
    assert.throws(
      () => agent.authorize(device.signAuthorization({ ...base, expiresAt: new Date(Date.now() - 1000).toISOString() })),
      /EXPIRED_OR_TOO_LONG/,
    );
    assert.throws(
      () => agent.authorize(device.signAuthorization({ ...base, expiresAt: new Date(Date.now() + 3 * 86_400_000).toISOString() })),
      /EXPIRED_OR_TOO_LONG/,
    );
  });

  it("is idempotent for the identical signed request, but refuses nonce reuse", () => {
    const { agent } = makeAgent("hang");
    const signed = device.signAuthorization({
      agentId: "inklink_payment_agent", merchantId: "shop_001",
      maxPerTransaction: "1.00", totalSpendingLimit: "5.00", asset: "USDC",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const a = agent.authorize(signed);
    const b = agent.authorize(signed);
    assert.equal(a.authorizationId, b.authorizationId);

    const reused = device.signAuthorization({
      agentId: "inklink_payment_agent", merchantId: "shop_001",
      maxPerTransaction: "9.00", totalSpendingLimit: "50.00", asset: "USDC",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      nonce: signed.nonce,
    });
    assert.throws(() => agent.authorize(reused), /already used/);
  });

  it("rejects nonsensical limits", () => {
    const { agent } = makeAgent("hang");
    assert.throws(() => authorize(agent, "5.00", "1.00"), /Spending limits/);
  });
});

describe("initiate: policy, resource allowlist, reservation", () => {
  it("rejects an amount above the per-transaction max before any signing", async () => {
    const { agent } = makeAgent("hang");
    const auth = authorize(agent, "0.50", "5.00");
    await assert.rejects(agent.initiate(initiateReq(auth.authorizationId, "job_1", "0.60")), /EXCEEDS_PER_TRANSACTION/);
  });

  it("rejects a merchant with no registered payout account", async () => {
    const { agent } = makeAgent("hang");
    const auth = authorize(agent, "1.00", "5.00", "shop_999");
    await assert.rejects(
      agent.initiate(initiateReq(auth.authorizationId, "job_1", "0.10", { merchantId: "shop_999" })),
      /payout account/,
    );
  });

  it("refuses a resourceUrl on a non-allowlisted origin", async () => {
    const { agent } = makeAgent("hang");
    const auth = authorize(agent);
    await assert.rejects(
      agent.initiate(initiateReq(auth.authorizationId, "job_1", "0.10", {
        resourceUrl: "http://evil.example/api/v1/jobs/job_1/execute",
      })),
      /not an allowed x402 gate/,
    );
  });

  it("refuses a resourceUrl for a different job", async () => {
    const { agent } = makeAgent("hang");
    const auth = authorize(agent);
    await assert.rejects(
      agent.initiate(initiateReq(auth.authorizationId, "job_1", "0.10", {
        resourceUrl: `${GATE}/api/v1/jobs/job_OTHER/execute`,
      })),
      /does not match this job/,
    );
  });

  it("refuses a resourceUrl with embedded credentials or a bad scheme", async () => {
    const { agent } = makeAgent("hang");
    const auth = authorize(agent);
    await assert.rejects(
      agent.initiate(initiateReq(auth.authorizationId, "job_1", "0.10", {
        resourceUrl: "http://user:pw@localhost:4022/api/v1/jobs/job_1/execute",
      })),
      /without credentials/,
    );
    await assert.rejects(
      agent.initiate(initiateReq(auth.authorizationId, "job_1", "0.10", { resourceUrl: "file:///etc/passwd" })),
      /without credentials|not an allowed/,
    );
  });

  it("treats the quote expiry as the payment deadline", async () => {
    const { agent } = makeAgent("hang");
    const auth = authorize(agent);
    await assert.rejects(
      agent.initiate(initiateReq(auth.authorizationId, "job_1", "0.10", {
        quoteExpiresAt: new Date(Date.now() - 1000).toISOString(),
      })),
      /quote has expired/,
    );
  });

  it("rejects zero or malformed settlement amounts", async () => {
    const { agent } = makeAgent("hang");
    const auth = authorize(agent);
    await assert.rejects(agent.initiate(initiateReq(auth.authorizationId, "j", "0")), /positive USDC/);
    await assert.rejects(agent.initiate(initiateReq(auth.authorizationId, "j", "0.0000001")), /positive USDC/);
    await assert.rejects(agent.initiate(initiateReq(auth.authorizationId, "j", "abc")), /positive USDC/);
  });

  it("reserves spend so concurrent payments cannot both pass the total limit", async () => {
    const { agent } = makeAgent("hang");
    const auth = authorize(agent, "1.00", "1.00");
    const first = await agent.initiate(initiateReq(auth.authorizationId, "job_a", "0.60"));
    assert.equal(first.status, "processing");
    await assert.rejects(agent.initiate(initiateReq(auth.authorizationId, "job_b", "0.60")), /EXCEEDS_TOTAL_LIMIT/);
  });

  it("releases the reservation when the facilitator rejects (no funds moved)", async () => {
    const { agent } = makeAgent("reject");
    const auth = authorize(agent, "1.00", "1.00");
    const first = await agent.initiate(initiateReq(auth.authorizationId, "job_c", "0.60"));
    await sleep(50);
    assert.equal(agent.inspect(first.paymentId)?.status, "failed");
    assert.equal(agent.inspect(first.paymentId)?.failureReason, "stub_rejected");
    const second = await agent.initiate(initiateReq(auth.authorizationId, "job_d", "0.60"));
    assert.notEqual(second.paymentId, first.paymentId);
  });

  it("is idempotent on (jobId, quoteId, authorizationId)", async () => {
    const { agent } = makeAgent("hang");
    const auth = authorize(agent);
    const a = await agent.initiate(initiateReq(auth.authorizationId, "job_e"));
    const b = await agent.initiate(initiateReq(auth.authorizationId, "job_e"));
    assert.equal(a.paymentId, b.paymentId);
  });

  it("never exposes a transaction id on Contract 7 unless settled", async () => {
    const { agent } = makeAgent("hang");
    const auth = authorize(agent);
    const p = await agent.initiate(initiateReq(auth.authorizationId, "job_f"));
    assert.equal(agent.status(p.paymentId)?.transactionId, null);
  });
});

describe("settlement flow (mirror node stubbed)", () => {
  const realFetch = globalThis.fetch;
  const mirror = (transactions: unknown[]) => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ transactions }), { status: 200 })) as typeof fetch;
  };

  it("settles, then sends ONE callback with the agreed fields and a real HashScan URL", async () => {
    mirror([
      {
        result: "SUCCESS",
        consensus_timestamp: "1700000000.123456789",
        token_transfers: [
          { token_id: "0.0.429274", account: "0.0.1001", amount: -100000 },
          { token_id: "0.0.429274", account: "0.0.2002", amount: 100000 },
        ],
      },
    ]);
    try {
      const { agent, delivered } = makeAgent("settle");
      const auth = authorize(agent);
      const p = await agent.initiate(initiateReq(auth.authorizationId, "job_ok", "0.10"));
      await sleep(80);

      const status = agent.status(p.paymentId);
      assert.equal(status?.status, "settled");
      assert.equal(status?.transactionId, "0.0.7162784@1700000000.000000001");
      assert.equal(agent.inspect(p.paymentId)?.callbackStatus, "delivered");

      assert.equal(delivered.length, 1);
      const e = delivered[0];
      assert.equal(e.paymentId, p.paymentId);
      assert.equal(e.jobId, "job_ok");
      assert.equal(e.payerAccount, "0.0.1001");
      assert.equal(e.merchantAccountId, "0.0.2002");
      assert.equal(e.network, "hedera:testnet");
      assert.equal(e.asset, "HTS_USDC");
      assert.equal(e.amount, "0.10");
      assert.equal(e.status, "settled");
      assert.equal(e.settlementTimestamp, "2023-11-14T22:13:20.123Z");
      assert.equal(
        e.hashscanUrl,
        "https://hashscan.io/testnet/transaction/0.0.7162784-1700000000-000000001",
      );
      assert.equal("signature" in e, false, "authentication is in headers, not the body");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("does NOT mark settled or call back when the mirror node cannot confirm", async () => {
    mirror([]);
    try {
      const { agent, delivered } = makeAgent("settle");
      const auth = authorize(agent, "1.00", "1.00");
      const p = await agent.initiate(initiateReq(auth.authorizationId, "job_un", "0.60"));
      await sleep(120);

      assert.equal(agent.status(p.paymentId)?.status, "failed");
      assert.equal(agent.status(p.paymentId)?.transactionId, null);
      assert.equal(agent.inspect(p.paymentId)?.failureReason, "settlement_unverified_on_mirror_node");
      assert.equal(agent.inspect(p.paymentId)?.transactionId, "0.0.7162784@1700000000.000000001");
      assert.equal(delivered.length, 0);
      // Funds may have moved: the reservation is kept, so this cannot be re-spent.
      await assert.rejects(agent.initiate(initiateReq(auth.authorizationId, "job_next", "0.60")), /EXCEEDS_TOTAL_LIMIT/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
