/**
 * OfflinePay in the app: the rules between "sign a promise" and "verified on Hedera".
 *
 * A voucher is a device-signed PROMISE to pay one job's backend-quoted USDC amount. It is not
 * a payment. The phone keeps its own ledger so it never signs past its offline limits (across
 * every shop), the backend checks and records the voucher, and the payment agent settles it
 * through x402. The app shows "settled" only when the backend reports a mirror-node verified
 * Hedera transaction for it.
 *
 * Kept free of React Native so every rule here is unit tested.
 */

import {
  OfflineLedger,
  type OfflineLedgerStorage,
  type OfflinePaymentRecord,
  type OfflinePaymentState,
  type OfflinePaymentVoucher,
} from "@inklink/shared-schemas";

/** The backend's record of a voucher (GET /api/v1/offline-payments/{voucherId}); never has the signature. */
export interface OfflineVoucherView {
  voucher: Omit<OfflinePaymentVoucher, "signature">;
  state: OfflinePaymentState;
  acceptedAt: string;
  updatedAt: string;
  settlementAttempts: number;
  paymentId?: string;
  /** Set only once SETTLED, from a mirror-node verified settlement. */
  transactionId?: string;
  verifiedAt?: string;
  failureReason?: string;
  /** Funds may have moved; waiting for verification. Never retried by anyone. */
  unresolved?: boolean;
}

/** POST /api/v1/offline-payments response. */
export interface SubmitOfflineVoucherResponse extends OfflineVoucherView {
  duplicate: boolean;
  settlement: string;
  jobId: string;
}

/** Storage that starts from a snapshot and keeps changes in memory (dry runs). */
class SnapshotStorage implements OfflineLedgerStorage {
  constructor(private records: OfflinePaymentRecord[]) {}
  load() {
    return JSON.parse(JSON.stringify(this.records)) as OfflinePaymentRecord[];
  }
  save(records: OfflinePaymentRecord[]) {
    this.records = JSON.parse(JSON.stringify(records)) as OfflinePaymentRecord[];
  }
}

/**
 * Would the phone's own ledger accept this voucher (signature, per-voucher limit, unsettled
 * limit across all shops, one voucher per job)? Checked on a throwaway copy, so nothing is
 * recorded for a voucher the backend may still refuse. Throws OfflinePayError if not.
 */
export function assertDeviceCanIssue(
  ledger: OfflineLedger,
  voucher: OfflinePaymentVoucher,
  verify: (message: string, signature: string, publicKey: string) => boolean,
  now: () => Date = () => new Date(),
): void {
  const copy = new OfflineLedger({ verify, policy: ledger.limits, storage: new SnapshotStorage(ledger.list()), now });
  copy.accept(voucher);
}

/**
 * How a submission attempt ended, from the app's point of view:
 *  - accepted: the backend recorded it, so the phone records it too;
 *  - unknown:  no answer (network). The backend may have it, so the phone records it
 *              (it counts against the limit) and the same voucher can be resent safely;
 *  - refused:  a definite answer from the backend. Nothing is recorded; the customer
 *              may pay another way.
 */
export type SubmitOutcome = "accepted" | "unknown" | "refused";

export function classifySubmitError(err: unknown): SubmitOutcome {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "GATEWAY_UNREACHABLE" ? "unknown" : "refused";
}

/**
 * Bring the phone's ledger in line with the backend's verified view. Only a SETTLED view with
 * a transaction id and verification time settles the phone's record (which frees its limit).
 * Anything else changes nothing: a failed settlement still counts, because the shop is unpaid.
 */
export function syncDeviceLedger(ledger: OfflineLedger, view: OfflineVoucherView): OfflinePaymentRecord | undefined {
  const id = view.voucher.voucherId;
  const mine = ledger.get(id);
  if (!mine) return undefined;
  if (view.state !== "SETTLED" || !view.transactionId || !view.verifiedAt) return mine;
  if (mine.state === "SETTLED") return mine;
  ledger.markPendingSettlement(id, view.paymentId);
  return ledger.reconcile(id, {
    jobId: view.voucher.jobId,
    paymentId: view.paymentId,
    paymentStatus: "SETTLED",
    amount: view.voucher.amount,
    transactionId: view.transactionId,
    transactionVerified: true,
    verifiedAt: view.verifiedAt,
  });
}

export interface OfflineStateText {
  title: string;
  detail: string;
  tone: "neutral" | "good" | "bad" | "accent";
  /** No further change is expected (stop polling). */
  final: boolean;
}

/** Customer-facing wording. Never calls a promise a payment. */
export function describeOfflineState(view: OfflineVoucherView): OfflineStateText {
  if (view.state === "SETTLED") {
    return { title: "Paid on Hedera", detail: "The promise was settled in USDC and verified on the Hedera mirror node.", tone: "good", final: true };
  }
  if (view.unresolved) {
    return {
      title: "Settling",
      detail: "The payment was sent and is being verified on Hedera. It will not be charged twice.",
      tone: "accent",
      final: false,
    };
  }
  if (view.state === "PENDING_SETTLEMENT") {
    return { title: "Settling", detail: "The payment agent is settling your promise on Hedera.", tone: "accent", final: false };
  }
  if (view.state === "SETTLEMENT_FAILED") {
    return {
      title: "Not settled yet",
      detail: `Settlement did not complete${view.failureReason ? ` (${view.failureReason})` : ""}. The shop retries automatically; your promise still stands.`,
      tone: "bad",
      final: false,
    };
  }
  return {
    title: "Promise accepted",
    detail: "The shop accepted your signed promise. It is not a payment yet: it settles on Hedera once the shop is online.",
    tone: "neutral",
    final: false,
  };
}

/** 3 s while things move; back off to 20 s after errors. Never give up while not final. */
export function offlinePollDelayMs(consecutiveErrors: number): number {
  if (consecutiveErrors <= 0) return 3000;
  return Math.min(20_000, 3000 * 2 ** (consecutiveErrors - 1));
}
