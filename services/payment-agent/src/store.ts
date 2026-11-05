/**
 * In-memory stores for the hackathon demo.
 *
 * - Authorizations: the customer-approved spending policies.
 * - Payments: keyed by a deterministic idempotency key so retries don't settle twice.
 *
 * Replace with Firestore/SQLite-backed persistence for production; interface kept
 * small so that swap is mechanical.
 */

import type {
  PaymentPolicy,
  PaymentStatus,
} from "@inklink/shared-schemas";

export interface PaymentRecord {
  paymentId: string;
  jobId: string;
  quoteId: string;
  authorizationId: string;
  merchantId: string;
  amount: string;
  asset: string;
  status: PaymentStatus;
  paymentReference: string;
  transactionId: string | null;
  settlementTimestamp: string | null;
  /** Why a payment failed, for debugging. Never contains secrets. */
  failureReason?: string;
  /** State of the signed settlement callback to the backend. */
  callbackStatus?: "pending" | "delivered" | "failed";
  callbackAttempts?: number;
  createdAt: string;
}

const authorizations = new Map<string, PaymentPolicy>();
/** nonce -> the signature + authorization it created (replay protection). */
const nonceIndex = new Map<string, { signature: string; authorizationId: string }>();
const payments = new Map<string, PaymentRecord>();
/** idempotency key -> paymentId */
const idempotencyIndex = new Map<string, string>();

export const nonceStore = {
  get(nonce: string) {
    return nonceIndex.get(nonce);
  },
  put(nonce: string, signature: string, authorizationId: string) {
    nonceIndex.set(nonce, { signature, authorizationId });
  },
};

export const authStore = {
  put(policy: PaymentPolicy) {
    authorizations.set(policy.authorizationId, policy);
  },
  get(id: string): PaymentPolicy | undefined {
    return authorizations.get(id);
  },
  update(id: string, patch: Partial<PaymentPolicy>) {
    const existing = authorizations.get(id);
    if (existing) authorizations.set(id, { ...existing, ...patch });
  },
};

export function idempotencyKey(
  jobId: string,
  quoteId: string,
  authorizationId: string,
): string {
  return `${jobId}:${quoteId}:${authorizationId}`;
}

export const paymentStore = {
  get(paymentId: string): PaymentRecord | undefined {
    return payments.get(paymentId);
  },
  findByIdempotency(key: string): PaymentRecord | undefined {
    const id = idempotencyIndex.get(key);
    return id ? payments.get(id) : undefined;
  },
  put(record: PaymentRecord, idemKey: string) {
    payments.set(record.paymentId, record);
    idempotencyIndex.set(idemKey, record.paymentId);
  },
  update(paymentId: string, patch: Partial<PaymentRecord>) {
    const existing = payments.get(paymentId);
    if (existing) payments.set(paymentId, { ...existing, ...patch });
  },
};
