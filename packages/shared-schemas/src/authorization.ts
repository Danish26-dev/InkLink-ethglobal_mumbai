/**
 * Customer payment authorization — device-key signature.
 *
 * The app generates an Ed25519 keypair on first launch (private key in secure
 * storage, never leaves the device) and signs the spending policy the customer
 * explicitly approves. The payment agent verifies this signature before the
 * policy is activated, so the authorization is cryptographically backed rather
 * than a bare JSON request.
 *
 * Signed bytes = UTF-8 of canonicalJson(authorizationSigningPayload(request)).
 * `signature`, `devicePublicKey` and `nonce` are Base64URL (unpadded).
 */

import type { AuthorizePaymentRequest } from "./contracts.js";

export const AUTHORIZATION_SIGNING_TYPE = "inklink_payment_authorization";
export const AUTHORIZATION_SIGNING_VERSION = "1.0";

/** Maximum lifetime the agent will accept for a single authorization. */
export const AUTHORIZATION_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** Everything in the request except `signature`, plus a type/version tag. */
export function authorizationSigningPayload(
  req: Omit<AuthorizePaymentRequest, "signature">,
) {
  return {
    type: AUTHORIZATION_SIGNING_TYPE,
    version: AUTHORIZATION_SIGNING_VERSION,
    customerReference: req.customerReference,
    agentId: req.agentId,
    merchantId: req.merchantId,
    maxPerTransaction: req.maxPerTransaction,
    totalSpendingLimit: req.totalSpendingLimit,
    asset: req.asset,
    nonce: req.nonce,
    expiresAt: req.expiresAt,
    devicePublicKey: req.devicePublicKey,
  };
}
