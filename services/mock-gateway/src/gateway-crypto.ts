/**
 * The mock gateway's identity: an Ed25519 keypair that signs the shop QR and answers
 * the pairing challenge, plus short-lived session tokens. Follows the agreed wire
 * format exactly (Base64URL keys/signatures, canonical JSON, signature excludes
 * itself) so the real gateway can be compared against it.
 */

import crypto from "node:crypto";
import {
  base64urlEncode,
  canonicalJson,
  type ShopQrPayload,
} from "@inklink/shared-schemas";

export interface GatewayIdentity {
  publicKey: string; // Base64URL raw Ed25519
  sign(text: string): string; // Base64URL signature over the UTF-8 bytes
}

export function createGatewayIdentity(): GatewayIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ format: "jwk" }).x as string,
    sign: (text) => base64urlEncode(crypto.sign(null, Buffer.from(text), privateKey)),
  };
}

export function buildQrPayload(
  id: GatewayIdentity,
  opts: { shopId: string; gatewayId: string; mdns: string; ip?: string; port: number; ttlMs: number },
): ShopQrPayload {
  const unsigned = {
    type: "inklink_shop" as const,
    version: "1.0",
    shopId: opts.shopId,
    gatewayId: opts.gatewayId,
    gateway: { discovery: "local" as const, mdns: opts.mdns, ip: opts.ip, port: opts.port },
    publicKey: id.publicKey,
    nonce: base64urlEncode(crypto.randomBytes(12)),
    expiresAt: new Date(Date.now() + opts.ttlMs).toISOString(),
  };
  return { ...unsigned, signature: id.sign(canonicalJson(unsigned)) };
}

export class SessionStore {
  private sessions = new Map<string, number>(); // token -> expiry ms

  constructor(private readonly ttlMs: number) {}

  issue(): { token: string; expiresAt: string } {
    const token = base64urlEncode(crypto.randomBytes(32));
    const expires = Date.now() + this.ttlMs;
    this.sessions.set(token, expires);
    return { token, expiresAt: new Date(expires).toISOString() };
  }

  check(token: string | undefined): "ok" | "expired" | "missing" {
    if (!token) return "missing";
    const exp = this.sessions.get(token);
    if (exp === undefined) return "missing";
    if (exp <= Date.now()) {
      this.sessions.delete(token);
      return "expired";
    }
    return "ok";
  }
}
