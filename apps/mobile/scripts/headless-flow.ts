/**
 * Headless run of the app's REAL client code against a backend, no phone needed.
 *
 *   BASE=http://localhost:8000 PAYMENT_EVENT_SIGNING_SECRET=... npx tsx scripts/headless-flow.ts
 *
 * Uses the same modules the app uses (QR validation, pairing handshake, API client,
 * device-key signing). Works against the mock backend; once the real backend exists
 * it can be pointed at it by changing BASE (only the /_dev/qr step is mock-specific).
 *
 * Job A  - the genuine path: authorize -> pay -> backend tells the agent -> x402 gate.
 *          Without a funded agent wallet this fails safely at the facilitator.
 * Job B  - the CALLBACK RECEIVER: forged / tampered / duplicate callbacks (synthetic,
 *          signed with the shared secret). Not a real payment.
 */

import { buildCallbackRequest, hashscanUrlFor } from "../../../services/payment-agent/src/settlement";
import { InklinkApi } from "../src/api/client";
import { buildSignedAuthorization } from "../src/crypto/authorization";
import { gatewayCandidates, validateScannedQr } from "../src/discovery/qr";
import { pickReachableOrigin, runHandshake } from "../src/discovery/pairing";
import { base64urlEncode } from "@inklink/shared-schemas";
import crypto from "node:crypto";

const BASE = process.env.BASE ?? "http://localhost:8000";
const SECRET = process.env.PAYMENT_EVENT_SIGNING_SECRET ?? "";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const line = (ok: boolean, text: string) => console.log(`${ok ? "PASS" : "FAIL"}  ${text}`);
let failures = 0;
const check = (ok: boolean, text: string) => {
  line(ok, text);
  if (!ok) failures++;
};

async function expectApiError(p: Promise<unknown>, code: string, text: string) {
  try {
    await p;
    check(false, `${text} (expected ${code}, got success)`);
  } catch (e: any) {
    check(e?.code === code, `${text} -> ${e?.code}`);
  }
}

async function main() {
  console.log(`Backend: ${BASE}\n── pairing ──`);
  const qrText = await (await fetch(`${BASE}/_dev/qr`)).text();
  const qr = validateScannedQr(qrText);
  check(true, `QR signature verified (shop ${qr.shopId}, ip hint ${qr.gateway.ip ?? "none"})`);

  const origin = await pickReachableOrigin(gatewayCandidates(qr));
  check(!!origin, `gateway reachable at ${origin}`);
  if (!origin) throw new Error("no reachable gateway");

  const api = new InklinkApi();
  api.configure(origin);
  await expectApiError(api.getShop(qr.shopId), "UNAUTHORIZED", "API refuses calls before pairing");

  const challenge = base64urlEncode(crypto.randomBytes(32));
  const session = await runHandshake(origin, qr, challenge);
  api.setSession({ token: session.sessionToken, expiresAt: session.sessionExpiresAt });
  check(true, "handshake: gateway proved it holds the QR key; session issued");
  check((await api.getShop(qr.shopId)).shopId === qr.shopId, "authenticated call works (Contract 1)");

  // A request with a wrong token must be refused.
  const bad = await fetch(`${origin}/api/v1/shops/${qr.shopId}`, { headers: { Authorization: "Bearer not-a-real-session-token" } });
  check(bad.status === 401, `forged session token refused (HTTP ${bad.status})`);

  console.log("\n── Job A: the genuine payment path ──");
  const jobA = await api.createJob({ shopId: qr.shopId, printConfig: { copies: 1, pageRange: "all", colourMode: "grayscale", paperSize: "A4" } });
  const form = new FormData();
  form.append("file", new Blob(["%PDF-1.4 headless test"], { type: "application/pdf" }), "test.pdf");
  form.append("shopId", qr.shopId);
  form.append("customerId", "headless");
  form.append("jobId", jobA.jobId);
  const up = await fetch(`${origin}/api/v1/documents`, {
    method: "POST", headers: { Authorization: `Bearer ${session.sessionToken}`, "Idempotency-Key": "k-1" }, body: form,
  });
  const upJson: any = await up.json();
  check(up.status === 200 && upJson.format === "pdf", `document uploaded (${upJson.documentId})`);

  const quoteA = await api.generateQuote(jobA.jobId);
  check(!!quoteA.settlement, `quote: INR ${quoteA.amount} = ${quoteA.settlement?.amount} USDC @ ${quoteA.settlement?.rate} (backend-computed)`);

  const secretKey = Uint8Array.from(crypto.randomBytes(32));
  const authReq = buildSignedAuthorization(
    secretKey,
    {
      agentId: "inklink_payment_agent", merchantId: quoteA.merchantId,
      maxPerTransaction: "1.00", totalSpendingLimit: "5.00", asset: "USDC",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    },
    crypto.randomBytes(16),
  );
  await expectApiError(
    api.authorizePayment({ ...authReq, totalSpendingLimit: "999.00" }),
    "AUTHORIZATION_SIGNATURE_INVALID",
    "tampered authorization refused by the agent",
  );
  const auth = await api.authorizePayment(authReq);
  check(auth.status === "active", `device-signed authorization accepted (${auth.authorizationId})`);

  const payA = await api.initiatePayment({ jobId: jobA.jobId, quoteId: quoteA.quoteId, authorizationId: auth.authorizationId, paymentMethod: "hedera_x402" });
  check(payA.status === "processing", `payment started (${payA.paymentId}); app sent only ids, never an amount`);

  let finalA = "processing";
  for (let i = 0; i < 12 && finalA === "processing"; i++) {
    await sleep(1500);
    finalA = (await api.getPaymentStatus(payA.paymentId)).status;
  }
  const stA = await api.getPaymentStatus(payA.paymentId);
  check(stA.status === "failed" && stA.transactionId === null, `no funded wallet -> ends '${stA.status}' with no tx id (backend learned of the failure)`);
  const jobStatusA = await api.getJobStatus(jobA.jobId);
  check(jobStatusA.status !== "awaiting_execution", `job NOT authorized for execution (status ${jobStatusA.status})`);

  if (!SECRET) {
    console.log("\n(set PAYMENT_EVENT_SIGNING_SECRET to also test the callback receiver)");
  } else {
    console.log("\n── Job B: callback receiver (synthetic callbacks, NOT a real payment) ──");
    const jobB = await api.createJob({ shopId: qr.shopId, printConfig: { copies: 1, pageRange: "all", colourMode: "grayscale", paperSize: "A4" } });
    const quoteB = await api.generateQuote(jobB.jobId);
    const authB = await api.authorizePayment(
      buildSignedAuthorization(secretKey, {
        agentId: "inklink_payment_agent", merchantId: quoteB.merchantId, maxPerTransaction: "1.00",
        totalSpendingLimit: "5.00", asset: "USDC", expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }, crypto.randomBytes(16)),
    );
    const payB = await api.initiatePayment({ jobId: jobB.jobId, quoteId: quoteB.quoteId, authorizationId: authB.authorizationId, paymentMethod: "hedera_x402" });

    const tx = "0.0.7162784@1700000000.000000001";
    const event = {
      paymentId: payB.paymentId, jobId: jobB.jobId, payerAccount: "0.0.1001", merchantAccountId: process.env.MERCHANT_ACCOUNT_ID ?? "0.0.2002",
      network: "hedera:testnet" as const, asset: "HTS_USDC" as const, amount: quoteB.settlement!.amount,
      transactionId: tx, settlementTimestamp: new Date().toISOString(), status: "settled" as const, hashscanUrl: hashscanUrlFor(tx),
    };
    const post = async (e: object, secret = SECRET, tamperBody?: (b: string) => string) => {
      const { body, headers } = buildCallbackRequest(e as any, secret);
      return fetch(`${origin}/api/v1/internal/payment-settled`, { method: "POST", headers, body: tamperBody ? tamperBody(body) : body });
    };

    check((await post(event, "wrong-secret-wrong-secret")).status === 401, "callback with the wrong secret -> 401");
    check((await post(event, SECRET, (b) => b.replace(`"amount":"${event.amount}"`, '"amount":"0.01"'))).status === 401, "callback body altered after signing -> 401");
    check((await post({ ...event, amount: "0.01" })).status === 422, "validly signed but wrong amount -> 422 (not applied)");
    check((await post({ ...event, merchantAccountId: "0.0.9999" })).status === 422, "validly signed but wrong merchant account -> 422");
    check((await post({ ...event, hashscanUrl: "https://hashscan.io/testnet/transaction/fake" })).status === 422, "hashscanUrl not derived from the tx id -> 422");
    check((await api.getJobStatus(jobB.jobId)).status === "awaiting_payment", "after all rejected callbacks the job is still awaiting_payment");

    const first = await post(event);
    check(first.status === 200, "valid signed callback accepted");
    const dup = await (await post(event)).json() as any;
    check(dup.duplicate === true, "duplicate callback is idempotent (no second effect)");
    check((await post({ ...event, transactionId: "0.0.7162784@1700000001.000000002", hashscanUrl: hashscanUrlFor("0.0.7162784@1700000001.000000002") })).status === 422, "same payment with a DIFFERENT tx id -> 422");

    const stB = await api.getPaymentStatus(payB.paymentId);
    check(stB.status === "settled" && stB.transactionId === tx, "backend now reports settled with the callback's tx id");
    const jobB2 = await api.getJobStatus(jobB.jobId);
    check(jobB2.status === "awaiting_execution" && jobB2.paymentStatus === "settled", `job moved to awaiting_execution, NOT completed (status ${jobB2.status})`);
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error("headless-flow crashed:", e);
  process.exit(1);
});
