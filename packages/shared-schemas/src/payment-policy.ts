/**
 * Payment authorization policy — the constraints the Payment Agent MUST check
 * before initiating any payment. Enforced server-side in the payment service.
 *
 * Security (see docs/SECURITY.md):
 *  - The agent wallet private key lives ONLY in the signing service.
 *  - Never exposed to an LLM or the mobile frontend.
 *  - Spending limits, per-tx max, merchant allowlist, asset, and expiry are all
 *    enforced before signing. Payments are idempotent and replay-protected.
 */

import type {
  DecimalString,
  IsoTimestamp,
  SettlementAsset,
} from "./common.js";
import type { AuthorizationStatus } from "./contracts.js";

export interface PaymentPolicy {
  authorizationId: string;
  customerReference: string;
  agentId: string;

  /** Merchant allowlist. A payment target must be in this list. */
  merchantAllowlist: string[];

  /** Per-transaction ceiling, settlement asset. */
  maxPerTransaction: DecimalString;

  /** Cumulative ceiling across the life of the authorization. */
  totalSpendingLimit: DecimalString;

  /** Running total already spent under this authorization. */
  spentToDate: DecimalString;

  asset: SettlementAsset;
  expiresAt: IsoTimestamp;
  status: AuthorizationStatus;
  createdAt: IsoTimestamp;

  /** Base64URL Ed25519 device key that signed this authorization. */
  devicePublicKey?: string;
}

/** Result of evaluating a proposed payment against a policy. */
export interface PolicyCheckResult {
  allowed: boolean;
  /** Populated when allowed === false. */
  violation?: PolicyViolation;
}

export type PolicyViolation =
  | "MERCHANT_NOT_ALLOWED"
  | "EXCEEDS_PER_TRANSACTION"
  | "EXCEEDS_TOTAL_LIMIT"
  | "WRONG_ASSET"
  | "AUTHORIZATION_EXPIRED"
  | "AUTHORIZATION_NOT_ACTIVE";

/** The vetted intent passed from the policy layer to the signing service. */
export interface PaymentIntent {
  paymentId: string;
  authorizationId: string;
  jobId: string;
  quoteId: string;
  merchantId: string;
  /** Settlement amount in the smallest unit is derived in the signing layer. */
  amount: DecimalString;
  asset: SettlementAsset;
  /** Unique reference for idempotency + replay protection. */
  paymentReference: string;
}
