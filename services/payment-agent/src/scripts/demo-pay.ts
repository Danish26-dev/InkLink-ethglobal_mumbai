/**
 * End-to-end x402 payment demo on Hedera testnet, in one process:
 *
 *   device-signed authorization -> initiate -> POST /jobs/{id}/execute -> 402 -> sign
 *   -> Blocky402 settle -> mirror-node verification -> signed callback -> HashScan link
 *
 *   npm run demo:pay                 # happy path: a genuine on-chain payment
 *   npm run demo:pay -- --negative   # agent asked to overpay: refused, nothing signed
 *
 * Requires a funded, USDC-associated agent wallet (see `npm run setup:wallet`).
 * Runs the gate in-process with a FIXED dev price. Nothing here fakes settlement:
 * success requires the mirror node to show the USDC transfer to the merchant.
 * The callback goes to BACKEND_EVENT_URL; if no backend is listening it will
 * retry and report "failed" — that does not affect the payment itself.
 */

import {
  loadHederaConfig,
  loadServerSecurityConfig,
  serviceConfig,
} from "../config.js";
import { fetchSupported, verifySupported } from "../facilitator.js";
import { FixedRequirementsSource } from "../gate-requirements.js";
import { PaymentAgent } from "../payment-agent.js";
import { deliverCallback } from "../settlement.js";
import { SigningService } from "../signing/signing-service.js";
import { X402Client } from "../x402-client.js";
import { HcsAuditPublisher, hashscanTopicUrl } from "../hcs-audit.js";
import { createX402Gate } from "../x402-gate.js";
import { createDevDevice } from "./dev-device.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const negative = process.argv.includes("--negative");
  const cfg = loadHederaConfig();
  const security = loadServerSecurityConfig();
  const price = process.env.EXAMPLE_PRICE_USDC ?? "0.10";
  // Negative case: the customer's policy would allow this, but the gate charges
  // `price`, so the agent must refuse to sign a different amount.
  const requested = negative ? "0.11" : price;

  const check = verifySupported(await fetchSupported());
  if (!check.ok) throw new Error(`Facilitator unsuitable: ${check.reasons.join("; ")}`);
  console.log(`Facilitator OK (Blocky402, feePayer ${check.feePayer})`);

  const gate = createX402Gate(
    new FixedRequirementsSource(price, cfg.merchantAccountId, cfg.usdcDecimals),
  ).listen(serviceConfig.gatePort);
  await sleep(1500); // let the middleware sync with the facilitator

  try {
    const signing = new SigningService();
    signingForClose = signing;
    const audit = serviceConfig.auditTopicId
      ? new HcsAuditPublisher(serviceConfig.auditTopicId, (topic, msg) => signing.submitTopicMessage(topic, msg))
      : undefined;
    console.log(audit ? `HCS audit log: ${hashscanTopicUrl(audit.topicId)}` : "HCS audit log: off (HCS_AUDIT_TOPIC_ID not set)");
    const agent = new PaymentAgent(new X402Client(signing), {
      audit,
      allowedResourceOrigins: [`http://localhost:${serviceConfig.gatePort}`],
      payerAccountId: signing.agentAccountId,
      deliver: (event) =>
        deliverCallback(event, {
          url: serviceConfig.backendEventUrl,
          secret: security.callbackSigningSecret,
          maxAttempts: 2,
          baseDelayMs: 500,
          onAttempt: (n, o) => console.log(`  callback attempt ${n}: ${o}`),
        }),
    });
    console.log(`Agent ${signing.agentAccountId} -> merchant ${cfg.merchantAccountId} (${cfg.merchantId})`);

    const device = createDevDevice();
    const auth = agent.authorize(
      device.signAuthorization({
        agentId: "inklink_payment_agent",
        merchantId: cfg.merchantId,
        maxPerTransaction: "1.00",
        totalSpendingLimit: "5.00",
        asset: "USDC",
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      }),
    );
    console.log(`Authorization ${auth.authorizationId} (device-signed; max 1.00 / total 5.00 USDC)`);

    const jobId = `job_demo_${Date.now()}`;
    const started = await agent.initiate({
      jobId,
      quoteId: "quote_demo",
      authorizationId: auth.authorizationId,
      paymentMethod: "hedera_x402",
      merchantId: cfg.merchantId,
      settlementAmount: requested,
      resourceUrl: `http://localhost:${serviceConfig.gatePort}/api/v1/jobs/${jobId}/execute`,
      quoteExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    console.log(`Payment ${started.paymentId} requested for ${requested} USDC (gate charges ${price}) …`);

    const deadline = Date.now() + 120_000;
    let rec = agent.inspect(started.paymentId);
    while (rec && rec.status === "processing" && Date.now() < deadline) {
      await sleep(2000);
      rec = agent.inspect(started.paymentId);
    }
    if (!rec) throw new Error("payment record vanished");

    // Give the callback retries and the HCS audit entry a moment to report.
    if (rec.status === "settled") {
      const auditDeadline = Date.now() + 30_000;
      await sleep(3000);
      while (audit && agent.inspect(started.paymentId)?.auditStatus === "pending" && Date.now() < auditDeadline) {
        await sleep(1000);
      }
    }
    rec = agent.inspect(started.paymentId) ?? rec;

    console.log("\n──────── RESULT ────────");
    console.log(`status:        ${rec.status}`);
    if (rec.failureReason) console.log(`reason:        ${rec.failureReason}`);
    if (rec.transactionId) console.log(`transaction:   ${rec.transactionId}`);
    if (rec.status === "settled") {
      console.log(`settled at:    ${rec.settlementTimestamp}`);
      console.log(`HashScan:      https://hashscan.io/testnet/transaction/${rec.transactionId}`);
      console.log(`callback:      ${rec.callbackStatus} (attempts: ${rec.callbackAttempts ?? 0})`);
      if (audit) {
        console.log(
          `HCS audit:     ${rec.auditStatus}` +
            (rec.auditSequenceNumber ? ` (topic ${rec.auditTopicId}, sequence #${rec.auditSequenceNumber})` : ""),
        );
        console.log(`audit log:     ${hashscanTopicUrl(audit.topicId)}`);
      }
    }

    const expected = negative ? "failed" : "settled";
    const ok = rec.status === expected;
    console.log(
      ok
        ? `\n✅ Expected outcome (${expected})${negative ? " — agent refused to sign a mismatched amount" : ""}`
        : `\n❌ Unexpected outcome: wanted ${expected}, got ${rec.status}`,
    );
    process.exitCode = ok ? 0 : 1;
  } finally {
    gate.close();
    signingForClose?.close();
  }
}

let signingForClose: SigningService | undefined;

main().catch((err) => {
  console.error("demo-pay failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
