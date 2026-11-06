/**
 * OfflinePay settlement on the agent: POST /api/v1/offline-payments/settle.
 *
 * The backend has already accepted the device-signed voucher offline and recorded it.
 * When internet returns it asks the agent to settle it. The agent checks again, because it
 * is the only party that can spend:
 *
 *   1. the voucher signature and fields (shared rules in @inklink/shared-schemas),
 *   2. that it matches this request exactly (job, quote, merchant, amount),
 *   3. its OWN per-device ledger: replay, one voucher per job, unsettled limit per device,
 *
 * then pays through the same x402 gate with the same exact-match signing, verifies on the
 * mirror node and sends the same signed callback with the backend's paymentId.
 *
 * Never double-pays: a voucher whose payment MAY have moved funds (claimed but unverified,
 * or interrupted) stays PENDING_SETTLEMENT and cannot be retried; it is resolved only by
 * mirror-node re-verification. A voucher is SETTLEMENT_FAILED only when nothing was
 * submitted, and only then may the backend retry with a new paymentId.
 */

import fs from "node:fs";
import path from "node:path";
import {
  OfflineLedger,
  OfflinePayError,
  base64urlDecode,
  jsonTextStorage,
  utf8,
  verifyOfflineVoucher,
  type OfflinePaymentRecord,
  type OfflinePaymentVoucher,
} from "@inklink/shared-schemas";
import { verifyEd25519 } from "./device-auth.js";
import { toSmallestUnit } from "./money.js";
import { PaymentError, type PaymentAgent } from "./payment-agent.js";
import { paymentStore } from "./store.js";

const USDC_DECIMALS = 6;
/** How long after a voucher stops being acceptable offline it may still be settled. */
export const SETTLE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const PAYMENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface OfflineSettleRequest {
  paymentId: string;
  jobId: string;
  quoteId: string;
  merchantId: string;
  settlementAmount: string;
  resourceUrl: string;
  voucher: unknown;
}

export interface OfflineSettleResponse {
  paymentId: string;
  voucherId: string;
  status: string;
  voucherState: OfflinePaymentRecord["state"];
}

/** Node verifier with the same signature as the shared rules expect. */
export function nodeEd25519Verify(message: string, signature: string, publicKey: string): boolean {
  try {
    return verifyEd25519(utf8(message), base64urlDecode(signature), base64urlDecode(publicKey));
  } catch {
    return false;
  }
}

/** Durable JSON file storage with atomic replace (temp + rename, retried on Windows locks). */
export function fileLedgerStorage(file: string) {
  return jsonTextStorage({
    read() {
      try {
        return fs.readFileSync(file, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
    write(text) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, text, "utf8");
      for (let attempt = 0; ; attempt++) {
        try {
          fs.renameSync(tmp, file);
          return;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if ((code === "EPERM" || code === "EBUSY") && attempt < 5) continue;
          throw err;
        }
      }
    },
  });
}

function mismatch(message: string) {
  return new PaymentError("VOUCHER_MISMATCH", message);
}

export class OfflineSettlement {
  constructor(
    private readonly agent: PaymentAgent,
    private readonly ledger: OfflineLedger,
    private readonly now: () => Date = () => new Date(),
  ) {
    agent.onPaymentFinished((paymentId) => this.syncPayment(paymentId));
  }

  async settle(req: OfflineSettleRequest): Promise<OfflineSettleResponse> {
    const now = this.now();
    if (!PAYMENT_ID.test(req.paymentId)) {
      throw new PaymentError("POLICY_VIOLATION", "paymentId must be 1-64 characters of [A-Za-z0-9_-]");
    }

    // Vouchers are settled after they stop being acceptable offline, so the time window is
    // checked as of just before expiry, plus a bounded grace period for settling.
    const raw = req.voucher as Partial<OfflinePaymentVoucher> | null;
    const expiresMs = typeof raw?.expiresAt === "string" ? Date.parse(raw.expiresAt) : NaN;
    if (Number.isFinite(expiresMs) && now.getTime() > expiresMs + SETTLE_GRACE_MS) {
      throw new PaymentError("VOUCHER_TOO_OLD", "This voucher is past its settlement window");
    }
    const verifyAt = Number.isFinite(expiresMs) ? new Date(Math.min(now.getTime(), expiresMs - 1)) : now;

    const v = verifyOfflineVoucher(req.voucher, { verify: nodeEd25519Verify, policy: this.ledger.limits, now: verifyAt });
    if (v.jobId !== req.jobId) throw mismatch("Voucher is for a different job");
    if (v.quoteId !== req.quoteId) throw mismatch("Voucher is for a different quote");
    if (v.merchantId !== req.merchantId) throw mismatch("Voucher is for a different merchant");
    let same = false;
    try {
      same = toSmallestUnit(v.amount, USDC_DECIMALS) === toSmallestUnit(req.settlementAmount, USDC_DECIMALS);
    } catch {
      same = false;
    }
    if (!same) throw mismatch("Voucher amount differs from the settlement amount");

    const { record } = this.ledger.accept(v, { verifyAt });

    switch (record.state) {
      case "SETTLED":
        return this.response(record);
      case "PENDING_SETTLEMENT":
        if (record.paymentId === req.paymentId) return this.response(record);
        throw new PaymentError(
          "VOUCHER_SETTLEMENT_IN_PROGRESS",
          "This voucher already has a settlement in progress (or with an unknown outcome); it cannot be retried",
        );
      case "SETTLEMENT_FAILED":
        if (record.paymentId === req.paymentId) {
          throw new PaymentError("PAYMENT_ID_CONFLICT", "Retry a failed voucher with a new paymentId");
        }
        break;
      case "AUTHORIZED_OFFLINE":
        break;
    }
    if (paymentStore.get(req.paymentId)) {
      throw new PaymentError("PAYMENT_ID_CONFLICT", "paymentId is already used by another payment");
    }

    const limits = this.ledger.limits;
    const pending = this.ledger.markPendingSettlement(v.voucherId, req.paymentId);
    try {
      this.agent.startVoucherPayment(
        {
          paymentId: req.paymentId,
          voucherId: v.voucherId,
          jobId: v.jobId,
          quoteId: v.quoteId,
          merchantId: v.merchantId,
          amount: v.amount,
          resourceUrl: req.resourceUrl,
          budget: {
            maxPerTransaction: limits.maxPerVoucher,
            totalSpendingLimit: limits.maxOutstanding,
            spentToDate: this.ledger.outstanding(v.devicePublicKey),
          },
        },
        now,
      );
    } catch (err) {
      // Nothing was submitted: record the failure so the backend may retry with a new paymentId.
      this.ledger.reconcile(v.voucherId, {
        jobId: v.jobId,
        paymentId: req.paymentId,
        paymentStatus: "FAILED",
        amount: v.amount,
        transactionId: null,
        transactionVerified: false,
        verifiedAt: null,
        failureReason: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    return this.response(this.ledger.get(pending.voucher.voucherId) ?? pending);
  }

  get(voucherId: string): OfflinePaymentRecord | undefined {
    return this.ledger.get(voucherId);
  }

  /** Bring a voucher in line with its payment's outcome. Safe to call any number of times. */
  syncPayment(paymentId: string) {
    const rec = this.ledger.list("PENDING_SETTLEMENT").find((r) => r.paymentId === paymentId);
    const payment = paymentStore.get(paymentId);
    if (!rec || !payment) return;
    if (payment.status === "settled" && payment.transactionId && payment.settlementTimestamp) {
      this.ledger.reconcile(rec.voucher.voucherId, {
        jobId: payment.jobId,
        paymentId,
        paymentStatus: "SETTLED",
        amount: payment.amount,
        transactionId: payment.transactionId,
        transactionVerified: true, // a payment is only "settled" after mirror-node verification
        verifiedAt: payment.settlementTimestamp,
      });
    } else if (payment.status === "failed" && payment.fundsMayHaveMoved === false) {
      this.ledger.reconcile(rec.voucher.voucherId, {
        jobId: payment.jobId,
        paymentId,
        paymentStatus: "FAILED",
        amount: payment.amount,
        transactionId: null,
        transactionVerified: false,
        verifiedAt: null,
        failureReason: payment.failureReason,
      });
    }
    // failed with funds possibly moved: stay PENDING until re-verification decides.
  }

  /** Run at startup after recovery: reconcile every pending voucher with its payment. */
  syncAll(): number {
    let n = 0;
    for (const r of this.ledger.list("PENDING_SETTLEMENT")) {
      if (r.paymentId) {
        this.syncPayment(r.paymentId);
        n++;
      }
    }
    return n;
  }

  private response(record: OfflinePaymentRecord): OfflineSettleResponse {
    const payment = record.paymentId ? paymentStore.get(record.paymentId) : undefined;
    return {
      paymentId: record.paymentId ?? "",
      voucherId: record.voucher.voucherId,
      status: payment?.status ?? (record.state === "SETTLED" ? "settled" : "processing"),
      voucherState: record.state,
    };
  }
}

export function isOfflinePayError(err: unknown): err is OfflinePayError {
  return err instanceof OfflinePayError;
}

export function createOfflineLedger(file: string): OfflineLedger {
  return new OfflineLedger({ verify: nodeEd25519Verify, storage: fileLedgerStorage(file) });
}
