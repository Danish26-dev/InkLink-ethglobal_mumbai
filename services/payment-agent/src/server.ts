/**
 * Payment Agent HTTP service — INTERNAL. Called by the Inklink backend, never by
 * the mobile app.
 *
 *   POST /api/v1/payments/authorizations   Contract 5 (device-signed policy)
 *   POST /api/v1/payments                  Contract 6 (backend supplies the USDC amount)
 *   GET  /api/v1/payments/{paymentId}      Contract 7
 *   GET  /health                           unauthenticated, no sensitive data
 *
 * Every route except /health requires `Authorization: Bearer <INTERNAL_API_TOKEN>`.
 * The x402 gate runs as a separate process (npm run gate).
 */

import express from "express";
import type {
  AgentInitiatePaymentRequest,
  AuthorizePaymentRequest,
} from "@inklink/shared-schemas";
import { bearerAuth } from "./auth.js";
import { loadServerSecurityConfig, serviceConfig } from "./config.js";
import { fetchSupported, verifySupported } from "./facilitator.js";
import { PaymentAgent, PaymentError } from "./payment-agent.js";
import { deliverCallback } from "./settlement.js";
import { SigningService } from "./signing/signing-service.js";
import { enablePersistence } from "./store.js";
import { HcsAuditPublisher, hashscanTopicUrl } from "./hcs-audit.js";
import {
  OfflineSettlement,
  createOfflineLedger,
  isOfflinePayError,
  type OfflineSettleRequest,
} from "./offline-settlement.js";
import { X402Client } from "./x402-client.js";

function errorBody(code: string, message: string) {
  return { success: false as const, error: { code, message } };
}

const HTTP_STATUS: Record<string, number> = {
  AUTHORIZATION_INVALID: 400,
  AUTHORIZATION_SIGNATURE_INVALID: 403,
  AUTHORIZATION_REPLAYED: 409,
  POLICY_VIOLATION: 403,
  RESOURCE_NOT_ALLOWED: 403,
  QUOTE_EXPIRED: 410,
  FACILITATOR_UNAVAILABLE: 503,
  // OfflinePay
  VOUCHER_MISMATCH: 422,
  VOUCHER_TOO_OLD: 410,
  VOUCHER_SETTLEMENT_IN_PROGRESS: 409,
  PAYMENT_ID_CONFLICT: 409,
  INVALID_VOUCHER: 400,
  AMOUNT_INVALID: 400,
  NOT_YET_VALID: 400,
  VALIDITY_TOO_LONG: 400,
  EXPIRED: 400,
  SIGNATURE_INVALID: 403,
  WRONG_MERCHANT: 403,
  OVER_VOUCHER_LIMIT: 403,
  OVER_OUTSTANDING_LIMIT: 403,
  REPLAYED: 409,
  DUPLICATE_JOB: 409,
  INVALID_TRANSITION: 409,
  SETTLEMENT_MISMATCH: 409,
  UNKNOWN_VOUCHER: 404,
};

function hasStrings(body: unknown, keys: string[]): body is Record<string, string> {
  if (typeof body !== "object" || body === null) return false;
  const o = body as Record<string, unknown>;
  return keys.every((k) => typeof o[k] === "string" && (o[k] as string).length > 0 && (o[k] as string).length <= 2048);
}

/** Cached Blocky402 readiness: no fallback, just a clear answer. */
let facilitatorState: { ok: boolean; reason?: string; at: number } | null = null;
async function facilitatorReady(): Promise<{ ok: boolean; reason?: string }> {
  if (facilitatorState && Date.now() - facilitatorState.at < 15_000) return facilitatorState;
  try {
    const check = verifySupported(await fetchSupported());
    facilitatorState = { ok: check.ok, reason: check.reasons.join("; "), at: Date.now() };
  } catch (err) {
    facilitatorState = {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
      at: Date.now(),
    };
  }
  return facilitatorState;
}

function main() {
  // Fail fast: no token / secret, no service.
  const security = loadServerSecurityConfig();

  // Durable state. Throws (and the service refuses to start) if the file is corrupt.
  const { loaded } = enablePersistence(serviceConfig.stateFile);
  console.log(
    `[payment-agent] state ${loaded ? "loaded from" : "created at"} ${serviceConfig.stateFile}`,
  );

  const signing = new SigningService();
  const audit = serviceConfig.auditTopicId
    ? new HcsAuditPublisher(serviceConfig.auditTopicId, (topic, msg) => signing.submitTopicMessage(topic, msg))
    : undefined;
  console.log(
    audit
      ? `[payment-agent] HCS spend audit log -> ${hashscanTopicUrl(audit.topicId)}`
      : "[payment-agent] HCS spend audit log off (set HCS_AUDIT_TOPIC_ID to enable)",
  );
  const agent = new PaymentAgent(new X402Client(signing), {
    audit,
    allowedResourceOrigins: security.allowedResourceOrigins,
    payerAccountId: signing.agentAccountId,
    deliver: (event) =>
      deliverCallback(event, {
        url: serviceConfig.backendEventUrl,
        secret: security.callbackSigningSecret,
        maxAttempts: serviceConfig.callbackMaxAttempts,
        onAttempt: (n, outcome) =>
          console.log(`[callback ${event.paymentId}] attempt ${n}: ${outcome}`),
      }),
  });

  // OfflinePay ledger: next to the agent state (on Cloud Run, the same private volume).
  // Refuses to start on a corrupt file, like the agent state.
  const offline = new OfflineSettlement(agent, createOfflineLedger(serviceConfig.offlineLedgerFile));
  console.log(`[payment-agent] OfflinePay ledger at ${serviceConfig.offlineLedgerFile}`);

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));

  app.get("/health", async (_req, res) => {
    const f = await facilitatorReady();
    res.json({ ok: true, facilitator: f.ok ? "ok" : "unavailable" });
  });

  app.use("/api/v1", bearerAuth(security.internalApiToken));

  // Contract 5 — activate a device-signed spending policy
  app.post("/api/v1/payments/authorizations", (req, res) => {
    if (
      !hasStrings(req.body, [
        "customerReference", "agentId", "merchantId", "maxPerTransaction",
        "totalSpendingLimit", "asset", "expiresAt", "nonce", "devicePublicKey", "signature",
      ])
    ) {
      res.status(400).json(errorBody("AUTHORIZATION_INVALID", "Missing or malformed authorization fields"));
      return;
    }
    try {
      res.json(agent.authorize(req.body as unknown as AuthorizePaymentRequest));
    } catch (err) {
      sendError(res, err);
    }
  });

  // Contract 6 — initiate. The BACKEND supplies merchantId, settlementAmount, resourceUrl.
  app.post("/api/v1/payments", async (req, res) => {
    if (
      !hasStrings(req.body, [
        "jobId", "quoteId", "authorizationId", "paymentMethod",
        "merchantId", "settlementAmount", "resourceUrl", "quoteExpiresAt",
      ])
    ) {
      res.status(400).json(errorBody("POLICY_VIOLATION", "Missing or malformed payment fields"));
      return;
    }
    const f = await facilitatorReady();
    if (!f.ok) {
      res.status(503).json(
        errorBody(
          "FACILITATOR_UNAVAILABLE",
          "The Blocky402 facilitator is unavailable or no longer supports hedera:testnet. " +
            "No other facilitator, network or asset will be used.",
        ),
      );
      return;
    }
    try {
      res.json(await agent.initiate(req.body as unknown as AgentInitiatePaymentRequest));
    } catch (err) {
      sendError(res, err);
    }
  });

  // OfflinePay — settle a device-signed voucher the backend accepted offline.
  app.post("/api/v1/offline-payments/settle", async (req, res) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (
      !hasStrings(body, ["paymentId", "jobId", "quoteId", "merchantId", "settlementAmount", "resourceUrl"]) ||
      typeof body?.voucher !== "object" ||
      body.voucher === null
    ) {
      res.status(400).json(errorBody("POLICY_VIOLATION", "Missing or malformed offline settlement fields"));
      return;
    }
    const f = await facilitatorReady();
    if (!f.ok) {
      res.status(503).json(errorBody("FACILITATOR_UNAVAILABLE", "The Blocky402 facilitator is unavailable"));
      return;
    }
    try {
      res.json(await offline.settle(body as unknown as OfflineSettleRequest));
    } catch (err) {
      sendError(res, err);
    }
  });

  app.get("/api/v1/offline-payments/:voucherId", (req, res) => {
    const rec = offline.get(req.params.voucherId);
    if (!rec) {
      res.status(404).json(errorBody("UNKNOWN_VOUCHER", "Unknown voucherId"));
      return;
    }
    const { signature, ...voucher } = rec.voucher;
    void signature;
    res.json({ ...rec, voucher });
  });

  // Contract 7 — payment status
  app.get("/api/v1/payments/:paymentId", (req, res) => {
    const status = agent.status(req.params.paymentId);
    if (!status) {
      res.status(404).json(errorBody("JOB_NOT_FOUND", "Unknown paymentId"));
      return;
    }
    res.json(status);
  });

  app.listen(serviceConfig.port, () => {
    console.log(`[payment-agent] listening on :${serviceConfig.port} (internal; bearer auth required)`);
    console.log(`[payment-agent] allowed x402 gates: ${security.allowedResourceOrigins.join(", ")}`);
    console.log(`[payment-agent] callback -> ${serviceConfig.backendEventUrl}`);
    // Resume anything a previous run left half-done. In the background: re-verifying can
    // take a while and must not delay accepting requests.
    void agent
      .recover()
      .then((s) =>
        console.log(
          `[payment-agent] recovery: ${s.reverified} re-verified, ` +
            `${s.outcomeUnknown} outcome-unknown (spend kept), ${s.callbacksResent} callbacks re-sent, ` +
            `${s.auditsRetried} audit entries retried, ${offline.syncAll()} offline vouchers reconciled`,
        ),
      )
      .catch((err) =>
        console.error("[payment-agent] recovery failed:", err instanceof Error ? err.message : err),
      );
    void facilitatorReady().then((f) =>
      console.log(
        f.ok
          ? "[payment-agent] Blocky402 facilitator OK (hedera:testnet, x402 v2, exact)"
          : `[payment-agent] WARNING facilitator not ready: ${f.reason}`,
      ),
    );
  });
}

function sendError(res: express.Response, err: unknown) {
  if (err instanceof PaymentError || isOfflinePayError(err)) {
    const status = err.code === "STORAGE_CORRUPT" ? 500 : (HTTP_STATUS[err.code] ?? 400);
    res.status(status).json(errorBody(err.code, err.message));
    return;
  }
  console.error("[payment-agent] unexpected error:", err instanceof Error ? err.message : err);
  res.status(500).json(errorBody("INTERNAL_ERROR", "Unexpected error"));
}

main();
