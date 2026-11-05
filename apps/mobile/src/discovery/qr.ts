/**
 * QR shop discovery — parse and cryptographically verify a SIGNED shop payload.
 *
 * Agreed format (Ed25519, Base64URL, canonical JSON):
 *   - publicKey / signature are Base64URL (raw 32-byte key, 64-byte signature)
 *   - signature covers the UTF-8 bytes of canonicalJson(payload WITHOUT `signature`)
 *   - the QR text is the payload as compact JSON, or the Base64URL of that JSON
 *
 * Validation order: structure -> local-only address -> expiry -> signature. A bare
 * URL, an unsigned QR, an expired QR or a tampered QR is never trusted. The
 * challenge-response handshake (pairing.ts) then proves the gateway actually holds
 * the private key before anything is sent to it.
 */

import {
  base64urlDecode,
  canonicalJson,
  type ShopQrPayload,
} from "@inklink/shared-schemas";
import { verifySignature } from "../crypto/ed25519";

export type QrErrorCode = "INVALID_QR" | "QR_EXPIRED" | "SIGNATURE_INVALID";

export class QrValidationError extends Error {
  constructor(
    public code: QrErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const MDNS_HOST = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

/** Private / link-local / loopback IPv4 only: a shop gateway lives on the shop LAN. */
export function isLocalIpv4(ip: string): boolean {
  if (!IPV4.test(ip)) return false;
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    a === 127
  );
}

function isLocalHostname(host: string): boolean {
  return MDNS_HOST.test(host) && (host.endsWith(".local") || host === "localhost");
}

/** Minimal UTF-8 decoder (avoids relying on TextDecoder being present in Hermes). */
function utf8Decode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i++];
    if (b < 0x80) out += String.fromCharCode(b);
    else if (b >= 0xc0 && b < 0xe0) out += String.fromCharCode(((b & 31) << 6) | (bytes[i++] & 63));
    else if (b >= 0xe0 && b < 0xf0) {
      out += String.fromCharCode(((b & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63));
    } else {
      const cp = ((b & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
      out += String.fromCodePoint(cp);
    }
  }
  return out;
}

/** Accept compact JSON or Base64URL(JSON). */
export function parseQrText(raw: string): unknown {
  const text = raw.trim();
  try {
    return JSON.parse(text.startsWith("{") ? text : utf8Decode(base64urlDecode(text)));
  } catch {
    throw new QrValidationError("INVALID_QR", "QR is not a valid Inklink shop code");
  }
}

function str(v: unknown, max = 128): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= max;
}

function decodedLength(b64u: unknown): number {
  try {
    return typeof b64u === "string" ? base64urlDecode(b64u).length : -1;
  } catch {
    return -1;
  }
}

/** The exact bytes the gateway signed: canonical JSON without `signature`. */
export function qrSigningText(p: ShopQrPayload): string {
  const { signature, ...unsigned } = p;
  void signature;
  return canonicalJson(unsigned);
}

function assertShape(v: unknown): ShopQrPayload {
  const bad = (m: string) => new QrValidationError("INVALID_QR", m);
  if (typeof v !== "object" || v === null) throw bad("QR is not an Inklink shop payload");
  const o = v as Record<string, any>;
  if (o.type !== "inklink_shop") throw bad("QR is not an Inklink shop payload");
  if (typeof o.version !== "string" || !o.version.startsWith("1.")) throw bad("Unsupported QR version");
  if (!str(o.shopId) || !str(o.gatewayId) || !str(o.nonce)) throw bad("QR is missing shop identity fields");
  if (typeof o.expiresAt !== "string" || Number.isNaN(Date.parse(o.expiresAt))) throw bad("QR has no valid expiry");
  if (decodedLength(o.publicKey) !== 32) throw bad("QR public key is not a valid Ed25519 key");
  if (decodedLength(o.signature) !== 64) throw bad("QR signature is malformed");

  const g = o.gateway;
  if (typeof g !== "object" || g === null || g.discovery !== "local") throw bad("QR has no local gateway address");
  if (!Number.isInteger(g.port) || g.port < 1 || g.port > 65535) throw bad("QR gateway port is invalid");
  if (typeof g.mdns !== "string" || !isLocalHostname(g.mdns)) {
    throw bad("QR gateway hostname must be a .local name");
  }
  if (g.ip !== undefined && (typeof g.ip !== "string" || !isLocalIpv4(g.ip))) {
    throw bad("QR gateway IP must be a private LAN address");
  }
  return o as ShopQrPayload;
}

/**
 * Parse and fully validate a scanned QR string. Throws QrValidationError with a
 * precise code so the UI can explain what went wrong.
 */
export function validateScannedQr(raw: string, now: Date = new Date()): ShopQrPayload {
  const payload = assertShape(parseQrText(raw));

  if (Date.parse(payload.expiresAt) <= now.getTime()) {
    throw new QrValidationError("QR_EXPIRED", "This shop QR has expired. Ask the shop to refresh it.");
  }
  if (!verifySignature(qrSigningText(payload), payload.signature, payload.publicKey)) {
    throw new QrValidationError("SIGNATURE_INVALID", "The shop's signature did not verify. Do not trust this code.");
  }
  return payload;
}

/**
 * Origins to try, in preference order. The IPv4 hint comes first because mDNS
 * (.local) frequently fails to resolve on Android; both are probed in parallel.
 */
export function gatewayCandidates(p: { gateway: { ip?: string | null; mdns: string; port: number } }): string[] {
  const { ip, mdns, port } = p.gateway;
  return [...(ip ? [`http://${ip}:${port}`] : []), `http://${mdns}:${port}`];
}
