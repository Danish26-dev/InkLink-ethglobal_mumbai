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
}

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

export async function runHandshake(
  origin: string,
  qr: ShopQrPayload,
  challenge: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PairingSession> {
  let res: Response;
  try {
    res = await withTimeout(
      fetchImpl(`${origin}/api/v1/pairing/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challenge }),
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
  return { sessionToken: body.sessionToken, sessionExpiresAt: body.sessionExpiresAt };
}
