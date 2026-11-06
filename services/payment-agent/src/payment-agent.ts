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
  PaymentStatus,
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
import { PaymentOutcomeUnknownError, X402Client } from "./x402-client.js";
import { buildSpendAuditMessage, type AuditPublisher } from "./hcs-audit.js";
import { discoverPrintJobEndpoint, quoteFromGate } from "./gate-discovery.js";

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
  /** Optional HCS spend audit log. Runs after settlement; never affects the payment. */
  audit?: AuditPublisher;
  /**
   * Endpoint discovery and price reading. With `discoveryOrigin`, the agent finds the job's
   * paid endpoint from the gate's published x402 discovery document (and refuses a different
   * URL from the caller). With `probePrice`, it reads the 402 price before signing and
   * refuses anything but the exact authorized amount, shop account and asset.
   */
  gate?: { discoveryOrigin?: string; probePrice?: boolean; fetchImpl?: typeof fetch };
}

export interface RecoverySummary {
  /** Payments with a claimed transaction id that were re-checked on the mirror node. */
  reverified: number;
  /** In-flight payments with no transaction id: outcome unknown, spend kept. */
  outcomeUnknown: number;
  /** Settled payments whose callback had not been delivered and was sent again. */
  callbacksResent: number;
  /** Settled payments whose HCS audit entry had not been published and was retried. */
  auditsRetried: number;
}

/** Mirror consensus timestamp "secs.nanos" -> ISO-8601. */
function consensusToIso(ts: string | undefined): string {
  if (!ts) return new Date().toISOString();
  const [secs, nanos = "0"] = ts.split(".");
  const ms = Number(secs) * 1000 + Math.floor(Number(nanos.padEnd(9, "0")) / 1e6);
  return new Date(ms).toISOString();
}

export interface VoucherPaymentInput {
  /** Supplied by the backend; becomes the paymentId of the settlement and its callback. */
  paymentId: string;
  voucherId: string;
  jobId: string;
  quoteId: string;
  merchantId: string;
  amount: string;
  resourceUrl: string;
  budget: { maxPerTransaction: string; totalSpendingLimit: string; spentToDate: string };
}

export class PaymentAgent {
  private readonly agentId: string;
  private readonly finishedListeners = new Set<(paymentId: string) => void>();

  /** Called once a payment reaches a final local outcome (settled or failed). */
  onPaymentFinished(listener: (paymentId: string) => void): () => void {
    this.finishedListeners.add(listener);
    return () => this.finishedListeners.delete(listener);
  }

  private notifyFinished(paymentId: string) {
    for (const l of this.finishedListeners) {
      try {
        l(paymentId);
      } catch (err) {
        console.warn(`[payment ${paymentId}] outcome listener failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * Start a payment authorized by an OfflinePay voucher (already verified and recorded by
   * the caller). Same gate, same exact-match x402 signing, same mirror-node verification,
   * callback and audit entry as an online payment. Throws before writing anything if the
   * resource or merchant is not allowed.
   */
  startVoucherPayment(input: VoucherPaymentInput, now: Date = new Date()): { paymentId: string; status: PaymentStatus } {
    const existing = paymentStore.get(input.paymentId);
    if (existing) {
      if (existing.offlineVoucherId === input.voucherId) return { paymentId: existing.paymentId, status: existing.status };
      throw new PaymentError("PAYMENT_ID_CONFLICT", "paymentId is already used by another payment");
    }
    this.assertResourceAllowed(input.resourceUrl, input.jobId);
    const payTo = resolveMerchantAccount(input.merchantId);
    if (!payTo) {
      throw new PaymentError("POLICY_VIOLATION", "No Hedera payout account is registered for this merchant");
    }
    const record: PaymentRecord = {
      paymentId: input.paymentId,
      jobId: input.jobId,
      quoteId: input.quoteId,
      authorizationId: `offline:${input.voucherId}`,
      offlineVoucherId: input.voucherId,
      budgetSnapshot: { ...input.budget },
      merchantId: input.merchantId,
      payTo,
      amount: input.amount,
      asset: SETTLEMENT_ASSET,
      status: "processing",
      paymentReference: crypto.randomUUID(),
      transactionId: null,
      settlementTimestamp: null,
      createdAt: now.toISOString(),
    };
    paymentStore.put(record, `offline:${input.voucherId}:${input.paymentId}`);
    this.settleInBackground(record, payTo, input.resourceUrl);
    return { paymentId: record.paymentId, status: "processing" };
  }

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
    const replay = () => {
      const existing = paymentStore.findByIdempotency(idemKey);
      return existing
        ? { paymentId: existing.paymentId, status: existing.status, paymentMethod: req.paymentMethod }
        : null;
    };
    const early = replay();
    if (early) return early;

    if (req.paymentMethod !== "hedera_x402") {
      throw new PaymentError("POLICY_VIOLATION", "Only hedera_x402 payments are handled here");
    }
    if (!authStore.get(req.authorizationId)) {
      throw new PaymentError("AUTHORIZATION_INVALID", "Unknown authorizationId");
    }

    // Find the paid endpoint ourselves rather than trusting the caller's URL. This is the
    // only await in initiate(): everything that reads or reserves state happens after it.
    let resourceUrl = req.resourceUrl;
    const discoveryOrigin = this.opts.gate?.discoveryOrigin;
    if (discoveryOrigin) {
      let discovered: string;
      try {
        discovered = await discoverPrintJobEndpoint(discoveryOrigin, req.jobId, this.opts.gate?.fetchImpl);
      } catch (err) {
        throw new PaymentError("RESOURCE_NOT_ALLOWED", `Endpoint discovery failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (resourceUrl && resourceUrl !== discovered) {
        throw new PaymentError("RESOURCE_NOT_ALLOWED", "resourceUrl differs from the endpoint the gate publishes for this job");
      }
      resourceUrl = discovered;
    }
    if (!resourceUrl) {
      throw new PaymentError("RESOURCE_NOT_ALLOWED", "No resourceUrl given and endpoint discovery is not configured");
    }

    const cfg = loadHederaConfig();

    // ── Everything from here to the reservation is synchronous on purpose. ──
    // No await between the idempotency check, the policy read and the reservation, so
    // two concurrent initiate() calls can neither both pay the same request nor both
    // pass the total-limit check against a stale spentToDate.
    const again = replay();
    if (again) return again;
    const policy = authStore.get(req.authorizationId);
    if (!policy) {
      throw new PaymentError("AUTHORIZATION_INVALID", "Unknown authorizationId");
    }
    try {
      if (toSmallestUnit(req.settlementAmount, cfg.usdcDecimals) <= 0n) throw new Error("zero");
    } catch {
      throw new PaymentError(
        "POLICY_VIOLATION",
        "settlementAmount must be a positive USDC decimal string (max 6 decimals)",
      );
    }

    const expiresMs = Date.parse(req.quoteExpiresAt);
    if (Number.isNaN(expiresMs)) {
      throw new PaymentError("POLICY_VIOLATION", "quoteExpiresAt must be an ISO-8601 timestamp");
    }
    if (expiresMs <= now.getTime()) {
      throw new PaymentError("QUOTE_EXPIRED", "The quote has expired; request a new quote");
    }

    this.assertResourceAllowed(resourceUrl, req.jobId);

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
      payTo,
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
    this.settleInBackground(record, payTo, resourceUrl);

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

  /** Fire-and-forget settlement that can never become an unhandled rejection. */
  private settleInBackground(record: PaymentRecord, payTo: string, resourceUrl: string) {
    this.runSettlement(record, payTo, resourceUrl).catch((err) => {
      // e.g. the state file could not be written. Keep the spend: the outcome is unknown.
      console.error(
        `[payment ${record.paymentId}] settlement aborted: ${err instanceof Error ? err.message : String(err)}`,
      );
      try {
        this.fail(record, "internal_error_outcome_unknown", false);
      } catch {
        /* persistence is failing too; recover() resolves it on the next start */
      }
    });
  }

  /**
   * Phase 1: pay the gate. Released only when nothing was signed (probe, 402 or policy
   * error) or the facilitator explicitly refused. Once a signed transfer has been sent,
   * any error keeps the spend (funds may have moved). Phase 2 (`finalize`) starts once
   * a transaction id exists.
   */
  private async runSettlement(record: PaymentRecord, payTo: string, resourceUrl: string) {
    let settlement: Awaited<ReturnType<X402Client["pay"]>>;
    try {
      if (this.opts.gate?.probePrice) {
        // Read the endpoint's own price first (unpaid request -> 402) and compare it with what
        // the customer authorized. Nothing is signed if they differ.
        const cfg = loadHederaConfig();
        const expected = toSmallestUnit(record.amount, cfg.usdcDecimals).toString();
        const quotes = await quoteFromGate(resourceUrl, this.opts.gate.fetchImpl);
        const match = quotes.find(
          (q) =>
            q.scheme === "exact" &&
            q.network === "hedera:testnet" &&
            q.asset === cfg.usdcTokenId &&
            q.payTo === payTo &&
            q.amount === expected,
        );
        if (!match) {
          const seen = quotes.map((q) => `${q.amount} of ${q.asset} to ${q.payTo}`).join("; ") || "none";
          this.fail(record, `gate_price_mismatch: authorized ${expected} of ${cfg.usdcTokenId} to ${payTo}; gate asked ${seen}`, true);
          return;
        }
        paymentStore.update(record.paymentId, {
          gateQuote: { amount: match.amount, asset: match.asset, payTo: match.payTo, resourceUrl, at: new Date().toISOString() },
        });
        console.log(
          `[payment ${record.paymentId}] gate quoted ${record.amount} USDC to ${match.payTo} at ${resourceUrl}; matches the authorized payment, signing`,
        );
      }

      settlement = await this.x402.pay(
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

    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (err instanceof PaymentOutcomeUnknownError) {
        // The signed transfer reached the gate (or may have): it may have settled.
        // Never release the spend and never let a retry pay it again.
        this.fail(record, reason, false);
        return;
      }
      // Nothing was signed (probe, 402 or policy error): no funds can have moved.
      this.fail(record, reason, true);
      return;
    }

    if (!settlement.success || !settlement.transaction) {
      // Facilitator refused: no funds moved, safe to release the reservation.
      this.fail(record, settlement.errorReason ?? "facilitator_rejected", true);
      return;
    }

    try {
      await this.finalize(record, payTo, settlement.transaction);
    } catch (err) {
      // A transaction exists, so funds may have moved: never release the spend here.
      this.fail(record, `finalize_error: ${err instanceof Error ? err.message : String(err)}`, false);
    }
  }

  /**
   * Phase 2: confirm the transfer on the mirror node and, if it is exactly what was
   * authorized, mark it settled and send the signed callback. Also used to resume after a
   * restart, so it takes only what is stored on the record.
   */
  private async finalize(record: PaymentRecord, payTo: string, transactionId: string) {
    const cfg = loadHederaConfig();

    // Record the claimed tx id immediately so it can be reconciled even if
    // verification below is slow or fails.
    paymentStore.update(record.paymentId, { transactionId });

    const verified = await verifyOnChainWithRetry(
      transactionId,
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
      // reserved and keep the tx id so a later recover() can re-check it.
      this.fail(record, "settlement_unverified_on_mirror_node", false);
      return;
    }

    const settledAt = consensusToIso(verified.consensusTimestamp);
    const event: PaymentSettledEvent = {
      paymentId: record.paymentId,
      jobId: record.jobId,
      payerAccount: this.opts.payerAccountId,
      merchantAccountId: payTo,
      network: "hedera:testnet",
      asset: "HTS_USDC",
      amount: record.amount,
      transactionId,
      settlementTimestamp: settledAt,
      status: "settled",
      hashscanUrl: hashscanUrlFor(transactionId),
    };
    paymentStore.update(record.paymentId, {
      status: "settled",
      failureReason: undefined,
      settlementTimestamp: settledAt,
      callbackStatus: "pending",
      event, // kept so the callback can be re-sent after a restart
      ...(this.opts.audit ? { auditStatus: "pending" as const, auditTopicId: this.opts.audit.topicId } : {}),
    });

    // Background: retries with backoff must never block or undo the settlement.
    void this.sendCallback(record.paymentId, event);
    if (this.opts.audit) void this.publishAudit(record.paymentId);
    this.notifyFinished(record.paymentId);
  }

  /**
   * Append the settlement to the HCS spend audit log. Best effort and idempotent per
   * payment: an already published entry is never sent again. If the process dies after HCS
   * accepted a message but before this was saved, a retry can append a duplicate entry;
   * readers de-duplicate by paymentId.
   */
  private async publishAudit(paymentId: string) {
    const audit = this.opts.audit;
    const rec = paymentStore.get(paymentId);
    if (!audit || !rec || rec.status !== "settled" || !rec.event || rec.auditStatus === "published") return;
    const policy = authStore.get(rec.authorizationId);
    try {
      const receipt = await audit.publish(
        buildSpendAuditMessage(rec.event, {
          agentId: this.agentId,
          merchantId: rec.merchantId,
          authorizationId: rec.authorizationId,
          budget: rec.budgetSnapshot ?? {
            maxPerTransaction: policy?.maxPerTransaction ?? "unknown",
            totalSpendingLimit: policy?.totalSpendingLimit ?? "unknown",
            spentToDate: policy?.spentToDate ?? "unknown",
          },
        }),
      );
      paymentStore.update(paymentId, {
        auditStatus: "published",
        auditTopicId: receipt.topicId,
        auditSequenceNumber: receipt.sequenceNumber,
      });
    } catch (err) {
      console.warn(`[audit ${paymentId}] HCS publish failed: ${err instanceof Error ? err.message : String(err)}`);
      paymentStore.update(paymentId, { auditStatus: "failed" });
    }
  }

  /**
   * Run once at startup, after state has been loaded from disk. Never guesses and never
   * releases spend that may have moved:
   *  - processing WITH a claimed tx id  -> re-verify it on the mirror node
   *  - failed as "unverified" with a tx -> re-verify (the mirror node may simply have lagged)
   *  - processing WITHOUT a tx id       -> outcome unknown: marked failed, spend KEPT for reconciliation
   *  - settled but callback undelivered -> send the stored callback again
   */
  async recover(): Promise<RecoverySummary> {
    const summary: RecoverySummary = { reverified: 0, outcomeUnknown: 0, callbacksResent: 0, auditsRetried: 0 };
    const work: Promise<unknown>[] = [];

    for (const rec of paymentStore.list()) {
      const wasUnverified =
        rec.status === "failed" && rec.failureReason === "settlement_unverified_on_mirror_node";

      if ((rec.status === "processing" || wasUnverified) && rec.transactionId && rec.payTo) {
        summary.reverified++;
        const payTo = rec.payTo;
        const tx = rec.transactionId;
        work.push(
          this.finalize(rec, payTo, tx).catch((err) =>
            this.fail(rec, `finalize_error: ${err instanceof Error ? err.message : String(err)}`, false),
          ),
        );
      } else if (rec.status === "processing") {
        summary.outcomeUnknown++;
        this.fail(rec, "interrupted_by_restart_outcome_unknown", false);
      } else if (rec.status === "settled" && rec.callbackStatus !== "delivered" && rec.event) {
        summary.callbacksResent++;
        work.push(this.sendCallback(rec.paymentId, rec.event));
      }
      if (this.opts.audit && rec.status === "settled" && rec.event && rec.auditStatus !== "published") {
        summary.auditsRetried++;
        work.push(this.publishAudit(rec.paymentId));
      }
    }

    await Promise.all(work);
    return summary;
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
      fundsMayHaveMoved: !releaseReservation,
    });
    queueMicrotask(() => this.notifyFinished(record.paymentId));
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
