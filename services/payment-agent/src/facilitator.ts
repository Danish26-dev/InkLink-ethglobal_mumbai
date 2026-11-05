/**
 * Blocky402 facilitator client.
 *
 * Verifies the facilitator advertises the exact configuration we require before
 * any payment code runs (locked rule: do not silently switch network or asset).
 */

import type { X402SupportedResponse } from "@inklink/shared-schemas";
import { facilitatorConfig } from "./config.js";

const REQUIRED_NETWORK = "hedera:testnet";
const REQUIRED_VERSION = 2;
const REQUIRED_SCHEME = "exact";

export interface FacilitatorCheck {
  ok: boolean;
  feePayer?: string;
  reasons: string[];
  raw: X402SupportedResponse;
}

export async function fetchSupported(
  url = facilitatorConfig.url,
): Promise<X402SupportedResponse> {
  const res = await fetch(`${url}/supported`);
  if (!res.ok) {
    throw new Error(`Facilitator /supported returned HTTP ${res.status}`);
  }
  return (await res.json()) as X402SupportedResponse;
}

/** Confirm Hedera testnet + x402 v2 + exact scheme + a feePayer are advertised. */
export function verifySupported(supported: X402SupportedResponse): FacilitatorCheck {
  const reasons: string[] = [];
  const kind = supported.kinds.find(
    (k) =>
      k.network === REQUIRED_NETWORK &&
      k.x402Version === REQUIRED_VERSION &&
      k.scheme === REQUIRED_SCHEME,
  );

  if (!kind) {
    reasons.push(
      `No kind advertising network=${REQUIRED_NETWORK}, x402Version=${REQUIRED_VERSION}, scheme=${REQUIRED_SCHEME}`,
    );
    return { ok: false, reasons, raw: supported };
  }

  const feePayer = kind.extra?.feePayer;
  if (!feePayer) {
    reasons.push("Hedera testnet kind has no feePayer in `extra`");
  }

  return { ok: reasons.length === 0, feePayer, reasons, raw: supported };
}
