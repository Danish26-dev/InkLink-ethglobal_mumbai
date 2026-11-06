/**
 * Shop discovery types — QR payload and BLE pairing.
 *
 * Security: the QR payload is a SIGNED JSON document. The app verifies the
 * gateway signature against the embedded public key, checks expiry, then runs a
 * challenge-response handshake to prove the gateway holds the matching private
 * key. An unsigned QR or a bare URL is NOT an authenticated shop.
 */

import type { IsoTimestamp } from "./common.js";

export type GatewayDiscoveryKind = "local";

export interface GatewayDiscoveryHint {
  discovery: GatewayDiscoveryKind;
  /** mDNS hostname hint, e.g. "gateway-001.local". May not resolve on every network (esp. Android). */
  mdns: string;
  /** Optional IPv4 address of the gateway on the shop LAN. Preferred when mDNS fails. */
  ip?: string;
  port: number;
  /**
   * Optional HTTPS origin of a cloud-hosted Inklink backend serving this shop
   * (e.g. "https://inklink-backend-xxxx.asia-south1.run.app"). Covered by the QR
   * signature, tried after the LAN addresses, and — like them — trusted only after
   * the challenge-response handshake proves the shop's key. Absent for LAN-only shops.
   */
  cloudOrigin?: string;
}

/**
 * Signed QR payload presented by a shop.
 *
 * Agreed encoding: Ed25519. `publicKey` (raw 32-byte key) and `signature` are
 * Base64URL. The signature covers the UTF-8 bytes of canonicalJson() of this
 * object WITHOUT the `signature` field (see wire-format.ts). The QR text is
 * either this object as compact JSON, or the Base64URL of that JSON.
 */
export interface ShopQrPayload {
  type: "inklink_shop";
  version: string; // "1.0"
  shopId: string;
  gatewayId: string;
  gateway: GatewayDiscoveryHint;
  /** Base64URL raw Ed25519 gateway public key; verifies `signature` and the handshake. */
  publicKey: string;
  nonce: string;
  expiresAt: IsoTimestamp;
  /** Base64URL Ed25519 signature over canonicalJson(payload without `signature`). */
  signature: string;
}

/** Result of validating + pairing with a scanned QR. */
export interface PairedShop {
  shopId: string;
  gatewayId: string;
  publicKey: string;
  /** Fingerprint of the gateway public key, associated with the paired shop. */
  publicKeyFingerprint: string;
  gateway: GatewayDiscoveryHint;
  pairedAt: IsoTimestamp;
}

/**
 * Challenge-response handshake: POST /api/v1/pairing/verify
 *
 * The app sends a fresh random `challenge` (Base64URL, 32 bytes). The gateway
 * signs the UTF-8 bytes of that exact challenge string with its Ed25519 key and
 * returns the Base64URL signature. The app verifies it against the public key from
 * the QR and checks `gatewayId` matches. Only then is the gateway trusted.
 */
export interface PairingChallenge {
  /** Random challenge the app sends; gateway must sign it. */
  challenge: string;
}

export interface PairingResponse {
  /** Base64URL gateway signature over the UTF-8 bytes of the challenge string. */
  signedChallenge: string;
  gatewayId: string;
  /**
   * Short-lived session token issued after a successful handshake. The app sends it
   * as `Authorization: Bearer <token>` on every later local API call (uploads
   * included). Field names beyond signedChallenge/gatewayId are PROPOSED.
   */
  sessionToken: string;
  sessionExpiresAt: IsoTimestamp;
}

/**
 * The four independent connection states the app tracks. These are distinct:
 * internet availability is NOT the same as cloud API availability.
 */
export interface ConnectionState {
  shopIdentified: boolean;
  localGatewayReachable: boolean;
  internetAvailable: boolean;
  cloudApiAvailable: boolean;
}

/**
 * Inklink BLE service + characteristic UUIDs (PROPOSED — pending XYZ confirmation).
 * Defined centrally so app and gateway do not pick random UUIDs independently.
 * BLE belongs to the shop gateway, not the ESP32. BLE is for discovery, pairing,
 * and lightweight messages ONLY — never document transfer.
 */
export const INKLINK_BLE = {
  SERVICE_UUID: "696e6b6c-696e-6b00-0000-000000000001",
  CHAR_SHOP_IDENTIFICATION: "696e6b6c-696e-6b00-0000-000000000002",
  CHAR_GATEWAY_IDENTIFICATION: "696e6b6c-696e-6b00-0000-000000000003",
  CHAR_PAIRING_CHALLENGE: "696e6b6c-696e-6b00-0000-000000000004",
  CHAR_PAIRING_RESPONSE: "696e6b6c-696e-6b00-0000-000000000005",
  CHAR_LOCAL_CONNECTION_INFO: "696e6b6c-696e-6b00-0000-000000000006",
  CHAR_GATEWAY_STATUS: "696e6b6c-696e-6b00-0000-000000000007",
} as const;
