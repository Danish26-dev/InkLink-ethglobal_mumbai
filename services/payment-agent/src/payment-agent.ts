/**
 * Payment Agent — orchestrates authorize → policy check → sign → settle → verify.
 *
 * Called ONLY by the Inklink backend (never by the app). The backend supplies the
 * authoritative USDC amount; this agent refuses to pay anything that differs from
 * it, and it never authorizes jobs: after verified settlement it sends a signed
 * callback and the backend owns the job/payment status.
 *
 * Money safety:
 *  - A spending policy is only activated by a valid device-key (Ed25519) signature.
 *  - The authorization policy is checked BEFORE anything is signed.
 *  - The amount is reserved against the total limit at initiate time (synchronously
 *    with the check, so concurrent payments cannot both slip under the limit) and
 *    released only if the payment definitively fails before any funds can move.
 *  - The agent only pays x402 gates on an allowlisted origin, at the job's own path.
 *  - `settled` is set only after the transfer is confirmed on the mirror node.
 */

import crypto from "node:crypto";
import type {
  AgentInitiatePaymentRequest,
  AuthorizePaymentRequest,
  AuthorizePaymentResponse,
  InitiatePaymentResponse,
  PaymentPolicy,
  PaymentSettledEvent,
  PaymentStatusResponse,
} from "@inklink/shared-schemas";
import { AGENT_ID, loadHederaConfig, resolveMerchantAccount } from "./config.js";
import { verifyAuthorizationSignature } from "./device-auth.js";
import { addDecimal, subDecimal, toSmallestUnit } from "./money.js";
import { checkPolicy } from "./policy.js";
import {
  authStore,
  idempotencyKey,
  nonceStore,
  paymentStore,
  type PaymentRecord,
} from "./store.js";
import {
  hashscanUrlFor,
  verifyOnChainWithRetry,
  type DeliveryResult,
} from "./settlement.js";
import { X402Client } from "./x402-client.js";

const SETTLEMENT_ASSET = "USDC";

export interface AgentOptions {
  /** Origins of x402 gates this agent may pay. Anything else is refused. */
  allowedResourceOrigins: string[];
  /** Public Hedera account of the agent wallet (the payer). */
  payerAccountId: string;
  /** Delivers the signed settlement callback (with retries). Injected so tests need no network. */
  deliver: (event: PaymentSettledEvent) => Promise<DeliveryResult>;
  agentId?: string;
  /** Mirror-node verification retry policy. Defaults suit real ingestion lag; tests shorten it. */
  verification?: { attempts: number; delayMs: number };
}

/** Mirror consensus timestamp "secs.nanos" -> ISO-8601. */
function consensusToIso(ts: string | undefined): string {
  if (!ts) return new Date().toISOString();
  const [secs, nanos = "0"] = ts.split(".");
  const ms = Number(secs) * 1000 + Math.floor(Number(nanos.padEnd(9, "0")) / 1e6);
  return new Date(ms).toISOString();
}

export class PaymentAgent {
  private readonly agentId: string;

  constructor(
    private readonly x402: X402Client,
    private readonly opts: AgentOptions,
  ) {
    this.agentId = opts.agentId ?? AGENT_ID;
  }

  /**
   * Activate a customer-authorized spending policy (Contract 5). Requires a valid
   * Ed25519 signature from the customer's device key. Idempotent: the exact same
   * signed request returns the existing authorization; the same nonce with a
   * different signature is a replay and is refused.
   */
  authorize(req: AuthorizePaymentRequest, now: Date = new Date()): AuthorizePaymentResponse {
    const check = verifyAuthorizationSignature(req, this.agentId, now);
    if (!check.ok) {
      throw new PaymentError(
        "AUTHORIZATION_SIGNATURE_INVALID",
        `Authorization rejected: ${check.reason}`,
      );
    }

    const decimals = loadHederaConfig().usdcDecimals;
    try {
      const max = toSmallestUnit(req.maxPerTransaction, decimals);
      const total = toSmallestUnit(req.totalSpendingLimit, decimals);
      if (max <= 0n || total < max) throw new Error("limits");
    } catch {
      throw new PaymentError(
        "AUTHORIZATION_INVALID",
        "Spending limits must be positive USDC amounts (max 6 decimals) with total >= per-transaction",
      );
    }

    const seen = nonceStore.get(req.nonce);
    if (seen) {
      if (seen.signature === req.signature) {
        const existing = authStore.get(seen.authorizationId);
        if (existing) {
          return {
            authorizationId: existing.authorizationId,
            status: existing.status,
            merchantId: req.merchantId,
            maxPerTransaction: existing.maxPerTransaction,
          };
        }
      }
      throw new PaymentError("AUTHORIZATION_REPLAYED", "This authorization nonce was already used");
    }

    const policy: PaymentPolicy = {
      authorizationId: `auth_${crypto.randomUUID().slice(0, 8)}`,
      customerReference: req.customerReference,
      agentId: req.agentId,
      merchantAllowlist: [req.merchantId],
      maxPerTransaction: req.maxPerTransaction,
      totalSpendingLimit: req.totalSpendingLimit,
      spentToDate: "0.00",
      asset: req.asset,
      expiresAt: req.expiresAt,
      status: "active",
      createdAt: now.toISOString(),
      devicePublicKey: req.devicePublicKey,
    };
    authStore.put(policy);
    nonceStore.put(req.nonce, req.signature, policy.authorizationId);

    return {
      authorizationId: policy.authorizationId,
      status: policy.status,
      merchantId: req.merchantId,
      maxPerTransaction: policy.maxPerTransaction,
    };
  }

  /**
   * Initiate a payment (Contract 6, backend -> agent). Idempotent on
   * (jobId, quoteId, authorizationId). `settlementAmount` is the USDC amount the
   * backend computed from the INR quote.
   */
  async initiate(
    req: AgentInitiatePaymentRequest,
    now: Date = new Date(),
  ): Promise<InitiatePaymentResponse> {
    const idemKey = idempotencyKey(req.jobId, req.quoteId, req.authorizationId);
    const existing = paymentStore.findByIdempotency(idemKey);
    if (existing) {
      return {
        paymentId: existing.paymentId,
        status: existing.status,
        paymentMethod: req.paymentMethod,
      };
    }

    if (req.paymentMethod !== "hedera_x402") {
      throw new PaymentError("POLICY_VIOLATION", "Only hedera_x402 payments are handled here");
    }

    const policy = authStore.get(req.authorizationId);
    if (!policy) {
      throw new PaymentError("AUTHORIZATION_INVALID", "Unknown authorizationId");
    }

    const cfg = loadHederaConfig();

    // ── Everything from here to the reservation is synchronous on purpose. ──
    // No await between the policy check and the reservation means two concurrent
    // initiate() calls cannot both pass the total-limit check.
    try {
      if (toSmallestUnit(req.settlementAmount, cfg.usdcDecimals) <= 0n) throw new Error("zero");
    } catch {
      throw new PaymentError(
        "POLICY_VIOLATION",
        "settlementAmount must be a positive USDC decimal string (max 6 decimals)",
      );
    }

    if (req.quoteExpiresAt && Date.parse(req.quoteExpiresAt) <= now.getTime()) {
      throw new PaymentError("QUOTE_EXPIRED", "The quote has expired; request a new quote");
    }

    this.assertResourceAllowed(req.resourceUrl, req.jobId);

    const check = checkPolicy(
      policy,
      { merchantId: req.merchantId, amount: req.settlementAmount, asset: SETTLEMENT_ASSET },
      now,
      cfg.usdcDecimals,
    );
    if (!check.allowed) {
      throw new PaymentError("POLICY_VIOLATION", `Policy violation: ${check.violation}`);
    }

    const payTo = resolveMerchantAccount(req.merchantId);
    if (!payTo) {
      throw new PaymentError(
        "POLICY_VIOLATION",
        "No Hedera payout account is registered for this merchant",
      );
    }

    authStore.update(policy.authorizationId, {
      spentToDate: addDecimal(policy.spentToDate, req.settlementAmount, cfg.usdcDecimals),
    });

    const paymentId = `payment_${crypto.randomUUID().slice(0, 8)}`;
    const record: PaymentRecord = {
      paymentId,
      jobId: req.jobId,
      quoteId: req.quoteId,
      authorizationId: req.authorizationId,
      merchantId: req.merchantId,
      amount: req.settlementAmount,
      asset: SETTLEMENT_ASSET,
      status: "processing",
      paymentReference: crypto.randomUUID(),
      transactionId: null,
      settlementTimestamp: null,
      createdAt: now.toISOString(),
    };
    paymentStore.put(record, idemKey);

    // Run the x402 settlement out-of-band; status is polled via Contract 7.
    void this.runSettlement(record, payTo, req.resourceUrl);

    return { paymentId, status: "processing", paymentMethod: req.paymentMethod };
  }

  /**
   * The agent only pays gates it has been told to trust, and only the gate path for
   * THIS job, so a compromised caller cannot point it at an arbitrary URL.
   */
  private assertResourceAllowed(resourceUrl: string, jobId: string) {
    let url: URL;
    try {
      url = new URL(resourceUrl);
    } catch {
      throw new PaymentError("RESOURCE_NOT_ALLOWED", "resourceUrl is not a valid URL");
    }
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password
    ) {
      throw new PaymentError("RESOURCE_NOT_ALLOWED", "resourceUrl must be plain http(s) without credentials");
    }
    if (!this.opts.allowedResourceOrigins.includes(url.origin)) {
      throw new PaymentError("RESOURCE_NOT_ALLOWED", `Origin ${url.origin} is not an allowed x402 gate`);
    }
    if (url.pathname !== `/api/v1/jobs/${encodeURIComponent(jobId)}/execute`) {
      throw new PaymentError("RESOURCE_NOT_ALLOWED", "resourceUrl does not match this job's execute route");
    }
  }

  private async runSettlement(record: PaymentRecord, payTo: string, resourceUrl: string) {
    const cfg = loadHederaConfig();
    try {
      const settlement = await this.x402.pay(
        resourceUrl,
        { payTo, amount: record.amount },
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": record.paymentId,
          },
          body: JSON.stringify({ jobId: record.jobId, paymentId: record.paymentId }),
        },
      );

      if (!settlement.success || !settlement.transaction) {
        // Facilitator refused: no funds moved, safe to release the reservation.
        this.fail(record, settlement.errorReason ?? "facilitator_rejected", true);
        return;
      }

      // Record the claimed tx id immediately so it can be reconciled even if
      // verification below is slow or fails.
      paymentStore.update(record.paymentId, { transactionId: settlement.transaction });

      const verified = await verifyOnChainWithRetry(
        settlement.transaction,
        {
          tokenId: cfg.usdcTokenId,
          payTo,
          amountAtomic: toSmallestUnit(record.amount, cfg.usdcDecimals),
        },
        this.opts.verification?.attempts,
        this.opts.verification?.delayMs,
      );

      if (!verified.verified) {
        // Funds MAY have moved. Mark failed for the client, but keep the spend
        // reserved and keep the tx id for manual reconciliation.
        this.fail(record, "settlement_unverified_on_mirror_node", false);
        return;
      }

      const settledAt = consensusToIso(verified.consensusTimestamp);
      paymentStore.update(record.paymentId, {
        status: "settled",
        settlementTimestamp: settledAt,
        callbackStatus: "pending",
      });

      const event: PaymentSettledEvent = {
        paymentId: record.paymentId,
        jobId: record.jobId,
        payerAccount: this.opts.payerAccountId,
        merchantAccountId: payTo,
        network: "hedera:testnet",
        asset: "HTS_USDC",
        amount: record.amount,
        transactionId: settlement.transaction,
        settlementTimestamp: settledAt,
        status: "settled",
        hashscanUrl: hashscanUrlFor(settlement.transaction),
      };

      // Background: retries with backoff must never block or undo the settlement.
      void this.sendCallback(record.paymentId, event);
    } catch (err) {
      // A thrown error before a settlement response means nothing was submitted.
      this.fail(record, err instanceof Error ? err.message : String(err), true);
    }
  }

  private async sendCallback(paymentId: string, event: PaymentSettledEvent) {
    try {
      const result = await this.opts.deliver(event);
      paymentStore.update(paymentId, {
        callbackStatus: result.delivered ? "delivered" : "failed",
        callbackAttempts: result.attempts,
      });
    } catch {
      paymentStore.update(paymentId, { callbackStatus: "failed" });
    }
  }

  private fail(record: PaymentRecord, reason: string, releaseReservation: boolean) {
    paymentStore.update(record.paymentId, {
      status: "failed",
      failureReason: reason.slice(0, 300),
    });
    // Operators need to know why. Reasons never contain keys or signatures.
    console.warn(
      `[payment ${record.paymentId}] failed (${releaseReservation ? "spend released" : "spend KEPT, funds may have moved"}): ${reason.slice(0, 200)}`,
    );
    if (releaseReservation) {
      const cfg = loadHederaConfig();
      const policy = authStore.get(record.authorizationId);
      if (policy) {
        authStore.update(policy.authorizationId, {
          spentToDate: subDecimal(policy.spentToDate, record.amount, cfg.usdcDecimals),
        });
      }
    }
  }

  /** Payment status (Contract 7). */
  status(paymentId: string): PaymentStatusResponse | null {
    const r = paymentStore.get(paymentId);
    if (!r) return null;
    return {
      paymentId: r.paymentId,
      jobId: r.jobId,
      status: r.status,
      network: "hedera_testnet",
      // Only expose a tx id as evidence once it is verified; unverified claims
      // stay internal (see inspect()).
      transactionId: r.status === "settled" ? r.transactionId : null,
      amount: r.amount,
      asset: "USDC",
      merchantId: r.merchantId,
    };
  }

  /** Debug/reconciliation view including failure reason + callback state. Not part of the public contract. */
  inspect(paymentId: string): PaymentRecord | null {
    return paymentStore.get(paymentId) ?? null;
  }
}

export class PaymentError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
