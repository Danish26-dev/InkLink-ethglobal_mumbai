import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { PaymentSettledEvent } from "@inklink/shared-schemas";
import { createDevDevice } from "../src/scripts/dev-device.js";

process.env.HEDERA_AGENT_ACCOUNT_ID = "0.0.1001";
process.env.HEDERA_AGENT_PRIVATE_KEY = "not-used-in-these-tests";
process.env.MERCHANT_ACCOUNT_ID = "0.0.2002";
process.env.MERCHANT_ID = "shop_001";

type AgentModule = typeof import("../src/payment-agent.js");
type AuditModule = typeof import("../src/hcs-audit.js");
let mod: AgentModule;
let audit: AuditModule;
before(async () => {
  mod = await import("../src/payment-agent.js");
  audit = await import("../src/hcs-audit.js");
});

const GATE = "http://localhost:4022";
const TX = "0.0.7162784@1700000000.000000001";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const event: PaymentSettledEvent = {
  paymentId: "payment_a",
  jobId: "job_secret_42",
  payerAccount: "0.0.1001",
  merchantAccountId: "0.0.2002",
  network: "hedera:testnet",
  asset: "HTS_USDC",
  amount: "0.10",
  transactionId: TX,
  settlementTimestamp: "2026-11-06T10:00:00.000Z",
  status: "settled",
  hashscanUrl: `https://hashscan.io/testnet/transaction/${TX}`,
};
const budget = { maxPerTransaction: "1.00", totalSpendingLimit: "5.00", spentToDate: "0.10" };

describe("spend audit message", () => {
  it("carries the verified payment and budget, with commitments instead of ids", () => {
    const m = audit.buildSpendAuditMessage(event, {
      agentId: "inklink_payment_agent",
      merchantId: "shop_001",
      authorizationId: "auth_123",
      budget,
    });
    assert.equal(m.type, "inklink.agent_spend");
    assert.equal(m.transactionId, TX);
    assert.equal(m.amount, "0.10");
    assert.equal(m.asset, "USDC");
    assert.equal(m.payer, "0.0.1001");
    assert.deepEqual(m.budget, budget);
    assert.equal(m.jobCommitment, crypto.createHash("sha256").update("inklink:job:job_secret_42").digest("hex"));
    assert.equal(m.authorizationCommitment, crypto.createHash("sha256").update("inklink:authorization:auth_123").digest("hex"));

    const text = audit.serializeAuditMessage(m);
    assert.ok(!text.includes("job_secret_42"), "raw job id must not be published");
    assert.ok(!text.includes("auth_123"), "raw authorization id must not be published");
    for (const field of ["customerReference", "devicePublicKey", "hashscanUrl"]) assert.ok(!text.includes(field));
    assert.ok(Buffer.byteLength(text) <= audit.HCS_MAX_MESSAGE_BYTES);
    assert.equal(audit.serializeAuditMessage(m), text, "canonical, so identical every time");
  });

  it("refuses a message larger than one HCS chunk", () => {
    const m = audit.buildSpendAuditMessage(event, {
      agentId: "a".repeat(2000), merchantId: "shop_001", authorizationId: "auth_1", budget,
    });
    assert.throws(() => audit.serializeAuditMessage(m), /1024/);
  });

  it("validates the topic id and submits the canonical text", async () => {
    assert.throws(() => new audit.HcsAuditPublisher("topic-1", async () => ({ topicId: "", sequenceNumber: "", transactionId: "" })), /Invalid HCS topic/);
    let sent = "";
    const pub = new audit.HcsAuditPublisher("0.0.5005", async (topicId, msg) => {
      sent = msg;
      return { topicId, sequenceNumber: "7", transactionId: "0.0.1001@1.2" };
    });
    const m = audit.buildSpendAuditMessage(event, { agentId: "x", merchantId: "shop_001", authorizationId: "a", budget });
    const r = await pub.publish(m);
    assert.equal(r.sequenceNumber, "7");
    assert.equal(sent, audit.serializeAuditMessage(m));
  });
});

describe("agent publishes the audit entry after a verified settlement", () => {
  const realFetch = globalThis.fetch;
  const mirrorConfirms = () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          transactions: [{
            result: "SUCCESS",
            consensus_timestamp: "1700000000.123456789",
            token_transfers: [
              { token_id: "0.0.429274", account: "0.0.1001", amount: -100000 },
              { token_id: "0.0.429274", account: "0.0.2002", amount: 100000 },
            ],
          }],
        }),
        { status: 200 },
      )) as typeof fetch;
  };
  const mirrorEmpty = () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ transactions: [] }), { status: 200 })) as typeof fetch;
  };

  const stubX402 = {
    pay: () => Promise.resolve({ success: true, transaction: TX, network: "hedera:testnet" }),
  } as unknown as ConstructorParameters<AgentModule["PaymentAgent"]>[0];

  function setup(fail = { value: false }) {
    const published: string[] = [];
    const publisher = new audit.HcsAuditPublisher("0.0.5005", async (topicId, msg) => {
      if (fail.value) throw new Error("hcs unavailable");
      published.push(msg);
      return { topicId, sequenceNumber: String(published.length), transactionId: "0.0.1001@2.3" };
    });
    const delivered: PaymentSettledEvent[] = [];
    const agent = new mod.PaymentAgent(stubX402, {
      allowedResourceOrigins: [GATE],
      payerAccountId: "0.0.1001",
      verification: { attempts: 2, delayMs: 5 },
      audit: publisher,
      deliver: async (e) => {
        delivered.push(e);
        return { delivered: true, attempts: 1 };
      },
    });
    return { agent, published, delivered };
  }

  const device = createDevDevice();
  const authorize = (agent: InstanceType<AgentModule["PaymentAgent"]>) =>
    agent.authorize(
      device.signAuthorization({
        agentId: "inklink_payment_agent",
        merchantId: "shop_001",
        maxPerTransaction: "1.00",
        totalSpendingLimit: "5.00",
        asset: "USDC",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    );
  const pay = (agent: InstanceType<AgentModule["PaymentAgent"]>, authorizationId: string, jobId: string) =>
    agent.initiate({
      jobId,
      quoteId: "quote_1",
      authorizationId,
      paymentMethod: "hedera_x402",
      merchantId: "shop_001",
      settlementAmount: "0.10",
      resourceUrl: `${GATE}/api/v1/jobs/${jobId}/execute`,
      quoteExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    });

  it("publishes one entry with the real tx and the budget after the payment", async () => {
    mirrorConfirms();
    try {
      const { agent, published } = setup();
      const auth = authorize(agent);
      const p = await pay(agent, auth.authorizationId, "job_audit_ok");
      await sleep(100);

      const rec = agent.inspect(p.paymentId);
      assert.equal(rec?.status, "settled");
      assert.equal(rec?.auditStatus, "published");
      assert.equal(rec?.auditTopicId, "0.0.5005");
      assert.equal(rec?.auditSequenceNumber, "1");
      assert.equal(published.length, 1);
      const entry = JSON.parse(published[0]);
      assert.equal(entry.transactionId, TX);
      assert.equal(entry.paymentId, p.paymentId);
      assert.equal(entry.budget.spentToDate, "0.100000");
      assert.equal(entry.budget.totalSpendingLimit, "5.00");
      assert.ok(!published[0].includes("job_audit_ok"));
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("an HCS failure never touches the payment, and a restart retries it once", async () => {
    mirrorConfirms();
    try {
      const fail = { value: true };
      const { agent, published, delivered } = setup(fail);
      const auth = authorize(agent);
      const p = await pay(agent, auth.authorizationId, "job_audit_fail");
      await sleep(100);

      const rec = agent.inspect(p.paymentId);
      assert.equal(rec?.status, "settled", "payment unaffected");
      assert.equal(rec?.callbackStatus, "delivered", "callback unaffected");
      assert.equal(delivered.length, 1);
      assert.equal(rec?.auditStatus, "failed");

      fail.value = false;
      const first = await agent.recover();
      assert.ok(first.auditsRetried >= 1);
      assert.equal(agent.inspect(p.paymentId)?.auditStatus, "published");
      const count = published.length;
      await agent.recover();
      assert.equal(published.length, count, "a published entry is never sent again");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("publishes nothing when the settlement is not verified", async () => {
    mirrorEmpty();
    try {
      const { agent, published } = setup();
      const auth = authorize(agent);
      const p = await pay(agent, auth.authorizationId, "job_audit_unverified");
      await sleep(100);
      assert.equal(agent.inspect(p.paymentId)?.status, "failed");
      assert.equal(agent.inspect(p.paymentId)?.auditStatus, undefined);
      assert.equal(published.length, 0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
