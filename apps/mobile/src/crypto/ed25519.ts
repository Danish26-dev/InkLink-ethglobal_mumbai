/**
 * Ed25519 primitives for the app (pure TypeScript — no React Native imports, so
 * it can be exercised under Node as well as inside the app).
 *
 * All messages are signed/verified as the UTF-8 bytes of a string (a canonical
 * JSON document or a pairing challenge). Keys and signatures travel as Base64URL.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { base64urlDecode, base64urlEncode, utf8 } from "@inklink/shared-schemas";

/** Verify a Base64URL Ed25519 signature over the UTF-8 bytes of `message`. */
export function verifySignature(
  message: string,
  signatureB64u: string,
  publicKeyB64u: string,
): boolean {
  try {
    const signature = base64urlDecode(signatureB64u);
    const publicKey = base64urlDecode(publicKeyB64u);
    if (signature.length !== 64 || publicKey.length !== 32) return false;
    return ed25519.verify(signature, utf8(message), publicKey);
  } catch {
    return false;
  }
}

/** Sign the UTF-8 bytes of `message`; returns a Base64URL signature. */
export function signMessage(message: string, secretKey: Uint8Array): string {
  return base64urlEncode(ed25519.sign(utf8(message), secretKey));
}

/** Base64URL raw public key for a 32-byte secret key. */
export function publicKeyFor(secretKey: Uint8Array): string {
  return base64urlEncode(ed25519.getPublicKey(secretKey));
}

/**
 * Short, human-comparable fingerprint of a public key (first 16 hex chars of its
 * SHA-256, grouped). Shown to the customer and stored with the paired shop.
 */
export function publicKeyFingerprint(publicKeyB64u: string): string {
  const hex = bytesToHex(sha256(base64urlDecode(publicKeyB64u))).slice(0, 16);
  return hex.replace(/(.{4})(?=.)/g, "$1-");
}
