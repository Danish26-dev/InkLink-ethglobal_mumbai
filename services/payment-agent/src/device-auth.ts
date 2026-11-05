/**
 * Verifies the customer's device-key signature on a payment authorization.
 *
 * The app signs canonicalJson(authorizationSigningPayload(request)) with the
 * Ed25519 key it generated on first launch. We verify it here (and the backend can
 * too) so a spending policy can never be activated by a bare JSON request.
 *
 * Checks, in order: field formats, key/signature lengths, customerReference is
 * bound to the signing key, expiry window, the signature itself. Replay (nonce)
 * handling lives in the agent because it needs state.
 */

import crypto from "node:crypto";
import {
  AUTHORIZATION_MAX_LIFETIME_MS,
  authorizationSigningPayload,
  base64urlDecode,
  canonicalJson,
  customerReferenceFor,
  utf8,
  type AuthorizePaymentRequest,
} from "@inklink/shared-schemas";

export type DeviceAuthFailure =
  | "MALFORMED_FIELDS"
  | "WRONG_AGENT"
  | "CUSTOMER_REFERENCE_MISMATCH"
  | "EXPIRED_OR_TOO_LONG"
  | "BAD_SIGNATURE";

export type DeviceAuthResult =
  | { ok: true }
  | { ok: false; reason: DeviceAuthFailure };

/** DER SubjectPublicKeyInfo prefix for a raw 32-byte Ed25519 public key. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const DECIMAL = /^\d+(\.\d+)?$/;

function tryDecode(text: unknown, expectedLength?: number, minLength?: number) {
  if (typeof text !== "string" || text.length === 0) return null;
  try {
    const bytes = base64urlDecode(text);
    if (expectedLength !== undefined && bytes.length !== expectedLength) return null;
    if (minLength !== undefined && bytes.length < minLength) return null;
    return bytes;
  } catch {
    return null;
  }
}

/** Verify an Ed25519 signature given a raw 32-byte public key. */
export function verifyEd25519(
  message: Uint8Array,
  signature: Uint8Array,
  rawPublicKey: Uint8Array,
): boolean {
  try {
    const key = crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(rawPublicKey)]),
      format: "der",
      type: "spki",
    });
    return crypto.verify(null, Buffer.from(message), key, Buffer.from(signature));
  } catch {
    return false;
  }
}

export function verifyAuthorizationSignature(
  req: AuthorizePaymentRequest,
  expectedAgentId: string,
  now: Date = new Date(),
): DeviceAuthResult {
  const publicKey = tryDecode(req.devicePublicKey, 32);
  const signature = tryDecode(req.signature, 64);
  const nonce = tryDecode(req.nonce, undefined, 16);
  if (
    !publicKey ||
    !signature ||
    !nonce ||
    typeof req.merchantId !== "string" ||
    req.merchantId.length === 0 ||
    typeof req.customerReference !== "string" ||
    typeof req.maxPerTransaction !== "string" ||
    typeof req.totalSpendingLimit !== "string" ||
    !DECIMAL.test(req.maxPerTransaction) ||
    !DECIMAL.test(req.totalSpendingLimit) ||
    req.asset !== "USDC"
  ) {
    return { ok: false, reason: "MALFORMED_FIELDS" };
  }

  if (req.agentId !== expectedAgentId) return { ok: false, reason: "WRONG_AGENT" };

  if (req.customerReference !== customerReferenceFor(req.devicePublicKey)) {
    return { ok: false, reason: "CUSTOMER_REFERENCE_MISMATCH" };
  }

  const expiresMs = Date.parse(req.expiresAt);
  if (
    !Number.isFinite(expiresMs) ||
    expiresMs <= now.getTime() ||
    expiresMs - now.getTime() > AUTHORIZATION_MAX_LIFETIME_MS
  ) {
    return { ok: false, reason: "EXPIRED_OR_TOO_LONG" };
  }

  const { signature: _sig, ...unsigned } = req;
  void _sig;
  const message = utf8(canonicalJson(authorizationSigningPayload(unsigned)));
  return verifyEd25519(message, signature, publicKey)
    ? { ok: true }
    : { ok: false, reason: "BAD_SIGNATURE" };
}
