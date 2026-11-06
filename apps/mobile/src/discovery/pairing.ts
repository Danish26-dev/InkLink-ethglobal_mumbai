/**
 * Pairing: find a reachable address, then prove the gateway holds the shop's
 * private key before trusting it with anything.
 *
 *   1. Probe the QR's address candidates (IPv4 hint + mDNS) in parallel.
 *      Reachability is NOT trust: any host can answer /health.
 *   2. POST /api/v1/pairing/verify {challenge} with a fresh random challenge.
 *   3. Verify the returned Ed25519 signature over that exact challenge string with
 *      the public key from the signed QR, and check gatewayId matches.
 *   4. Only then accept the short-lived session token, sent as a Bearer token on
 *      every later local call (uploads included).
 */

import type { ShopQrPayload } from "@inklink/shared-schemas";
import { verifySignature } from "../crypto/ed25519";

export type PairingErrorCode = "GATEWAY_UNREACHABLE" | "PAIRING_FAILED" | "SIGNATURE_INVALID";

export class PairingError extends Error {
  constructor(
    public code: PairingErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface PairingSession {
  sessionToken: string;
  sessionExpiresAt: string;
  /** Stable `native_dev_…` id the backend derives from the proven device key (if sent). */
  customerReference?: string;
}

/** The device's proof that this is the same install: its key and a signature over the challenge. */
export interface DeviceProof {
  devicePublicKey: string;
  deviceSignature: string;
}

/** A pairing challenge the app generated: exactly 32 random bytes, Base64URL (43 chars). */
const APP_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Sign a pairing challenge with the device key. The same key signs payment budgets and
 * offline vouchers, so it only ever signs a challenge of the app's own random format, never
 * text chosen by someone else (a "challenge" that is really a payment would be refused).
 */
export function buildDeviceProof(
  challenge: string,
  sign: (message: string) => string,
  devicePublicKey: string,
): DeviceProof {
  if (!APP_CHALLENGE.test(challenge)) {
    throw new PairingError("PAIRING_FAILED", "Refusing to sign something that is not an app-generated pairing challenge");
  }
  return { devicePublicKey, deviceSignature: sign(challenge) };
}

const CUSTOMER_REF = /^native_dev_[0-9a-f]{8,64}$/;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

/** Probe all candidates at once; return the first reachable one in preference order. */
export async function pickReachableOrigin(
  candidates: string[],
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 2500,
): Promise<string | null> {
  const results = await Promise.all(
    candidates.map(async (origin) => {
      try {
        const res = await withTimeout(fetchImpl(`${origin}/health`), timeoutMs);
        return res.ok;
      } catch {
        return false;
      }
    }),
  );
  const index = results.findIndex(Boolean);
  return index === -1 ? null : candidates[index];
}

/** What the handshake needs from a shop: the pinned key and gateway id (from a QR or from storage). */
export type PinnedShopKey = Pick<ShopQrPayload, "publicKey" | "gatewayId">;

export async function runHandshake(
  origin: string,
  qr: PinnedShopKey,
  challenge: string,
  fetchImpl: typeof fetch = fetch,
  device?: DeviceProof,
): Promise<PairingSession> {
  let res: Response;
  try {
    res = await withTimeout(
      fetchImpl(`${origin}/api/v1/pairing/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(device ? { challenge, ...device } : { challenge }),
      }),
      5000,
    );
  } catch {
    throw new PairingError("GATEWAY_UNREACHABLE", "The shop gateway did not respond");
  }

  let body: any;
  try {
    body = await res.json();
  } catch {
    throw new PairingError("PAIRING_FAILED", "The gateway returned an unreadable pairing response");
  }
  if (!res.ok) {
    throw new PairingError("PAIRING_FAILED", body?.error?.message ?? `Pairing failed (HTTP ${res.status})`);
  }

  if (typeof body.signedChallenge !== "string" || !verifySignature(challenge, body.signedChallenge, qr.publicKey)) {
    throw new PairingError(
      "SIGNATURE_INVALID",
      "This gateway could not prove it holds the shop's key. It may be an impostor.",
    );
  }
  if (body.gatewayId !== qr.gatewayId) {
    throw new PairingError("SIGNATURE_INVALID", "Gateway identity does not match the shop's QR code");
  }
  if (
    typeof body.sessionToken !== "string" ||
    body.sessionToken.length < 16 ||
    Number.isNaN(Date.parse(body.sessionExpiresAt)) ||
    Date.parse(body.sessionExpiresAt) <= Date.now()
  ) {
    throw new PairingError("PAIRING_FAILED", "The gateway did not issue a valid session");
  }
  if (body.customerReference !== undefined && (typeof body.customerReference !== "string" || !CUSTOMER_REF.test(body.customerReference))) {
    throw new PairingError("PAIRING_FAILED", "The gateway returned an invalid customer reference");
  }
  return {
    sessionToken: body.sessionToken,
    sessionExpiresAt: body.sessionExpiresAt,
    ...(body.customerReference ? { customerReference: body.customerReference as string } : {}),
  };
}

/**
 * Handshake that also proves the device key, so the backend keeps the same customer identity
 * across pairings and session renewals. If an identity is already known, a renewal that
 * returns a different one is refused (the app would lose access to its own jobs).
 */
export async function handshakeWithDevice(
  origin: string,
  qr: PinnedShopKey,
  challenge: string,
  proveDevice: (challenge: string) => Promise<DeviceProof> | DeviceProof,
  knownCustomerReference?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PairingSession> {
  const proof = await proveDevice(challenge);
  const session = await runHandshake(origin, qr, challenge, fetchImpl, proof);
  if (knownCustomerReference && session.customerReference && session.customerReference !== knownCustomerReference) {
    throw new PairingError("PAIRING_FAILED", "The shop returned a different customer identity for this device");
  }
  return session;
}
