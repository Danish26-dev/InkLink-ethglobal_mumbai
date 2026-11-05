/**
 * Payment policy engine.
 *
 * Enforces the customer-authorized spending policy BEFORE any signing happens.
 * A violation aborts the payment and never reaches the facilitator.
 */

import type {
  PaymentPolicy,
  PolicyCheckResult,
} from "@inklink/shared-schemas";
import { addDecimal, compareDecimal } from "./money.js";

export interface ProposedPayment {
  merchantId: string;
  amount: string; // decimal string, settlement asset
  asset: string; // settlement asset symbol, e.g. "USDC"
}

/**
 * Check a proposed payment against the authorized policy.
 * Pure function — no side effects, no signing.
 */
export function checkPolicy(
  policy: PaymentPolicy,
  proposed: ProposedPayment,
  now: Date = new Date(),
  decimals = 6,
): PolicyCheckResult {
  if (policy.status !== "active") {
    return { allowed: false, violation: "AUTHORIZATION_NOT_ACTIVE" };
  }

  if (new Date(policy.expiresAt).getTime() <= now.getTime()) {
    return { allowed: false, violation: "AUTHORIZATION_EXPIRED" };
  }

  if (proposed.asset !== policy.asset) {
    return { allowed: false, violation: "WRONG_ASSET" };
  }

  if (!policy.merchantAllowlist.includes(proposed.merchantId)) {
    return { allowed: false, violation: "MERCHANT_NOT_ALLOWED" };
  }

  if (compareDecimal(proposed.amount, policy.maxPerTransaction, decimals) > 0) {
    return { allowed: false, violation: "EXCEEDS_PER_TRANSACTION" };
  }

  // spentToDate + this payment must not exceed the total limit.
  const projected = addDecimal(policy.spentToDate, proposed.amount, decimals);
  if (compareDecimal(projected, policy.totalSpendingLimit, decimals) > 0) {
    return { allowed: false, violation: "EXCEEDS_TOTAL_LIMIT" };
  }

  return { allowed: true };
}
