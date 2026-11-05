/**
 * x402 protocol types for Hedera (exact scheme, x402Version 2).
 *
 * These mirror the official @x402/core v2.30 wire types so the app, the payment
 * agent and the backend agree on shapes. Verified against:
 *  - @x402/core / @x402/hedera 2.30.0 type definitions
 *  - Blocky402 testnet facilitator GET /supported (live):
 *      { x402Version: 2, scheme: "exact", network: "hedera:testnet",
 *        extra: { feePayer: "0.0.7162784" } }
 *  - Hedera x402 "exact scheme" docs: HTS amounts in the token's smallest unit;
 *    the facilitator is the fee payer and submits a partially-signed transfer.
 *
 * Transport headers (v2): the server challenges with HTTP 402 and a
 * `PAYMENT-REQUIRED` header, the client retries with `PAYMENT-SIGNATURE`
 * (legacy `X-PAYMENT` also accepted), and the server returns settlement in
 * `PAYMENT-RESPONSE`.
 *
 * See docs/PAYMENT_FLOW.md for the full negotiation loop.
 */

import type { DecimalString } from "./common.js";

/** CAIP-2 network identifier. We settle on hedera:testnet. */
export type X402Network = "hedera:testnet" | "hedera:mainnet";

/** A facilitator-supported kind as returned by GET /supported. */
export interface X402SupportedKind {
  x402Version: number;
  scheme: string;
  network: string; // CAIP-2, e.g. "hedera:testnet"
  extra?: {
    feePayer?: string; // Hedera account id, e.g. "0.0.7162784"
    [k: string]: unknown;
  };
}

export interface X402SupportedResponse {
  kinds: X402SupportedKind[];
  extensions: unknown[];
  signers: Record<string, string[]>;
}

/**
 * One acceptable way to pay. For Hedera, `extra.feePayer` is the facilitator
 * account that pays network fees.
 */
export interface X402PaymentRequirements {
  scheme: string; // "exact"
  network: string; // "hedera:testnet"
  /** Asset entity id. HBAR = "0.0.0"; HTS token by entity id (testnet USDC = "0.0.429274"). */
  asset: string;
  /** Amount in the asset's smallest unit (per token decimals), as a string. */
  amount: string;
  /** Hedera account id receiving the payment (merchant). */
  payTo: string;
  maxTimeoutSeconds: number;
  extra: {
    feePayer?: string;
    [k: string]: unknown;
  };
}

export interface X402ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
}

/** Body/header payload of an HTTP 402 challenge. */
export interface X402PaymentRequired {
  x402Version: number;
  error?: string;
  resource: X402ResourceInfo;
  accepts: X402PaymentRequirements[];
}

/** Settlement result returned by the facilitator (and relayed in PAYMENT-RESPONSE). */
export interface X402SettleResponse {
  success: boolean;
  errorReason?: string;
  errorMessage?: string;
  payer?: string;
  /** Real Hedera transaction id, e.g. "0.0.1234@1699999999.000000000". */
  transaction: string;
  network: string;
  /** Actual amount settled in atomic units, when reported. */
  amount?: string;
}

/**
 * Internal callback: Payment Agent -> Inklink backend,
 * POST /api/v1/internal/payment-settled
 *
 * Sent only AFTER the agent verified the transfer on the Hedera mirror node. The
 * backend validates it, records it idempotently (paymentId is the idempotency
 * key) and moves the job to awaiting_execution — never to completed.
 *
 * Authentication is carried in HEADERS over the RAW body bytes, not inside the
 * JSON (a signature field breaks when a language re-serializes JSON differently):
 *
 *   X-Inklink-Timestamp: <unix epoch seconds>
 *   X-Inklink-Signature: sha256=<hex HMAC-SHA256(secret, timestamp + "." + rawBody)>
 *
 * Reject if the timestamp is older than 5 minutes. The timestamp is inside the
 * MAC so a captured request cannot be replayed with a fresh timestamp.
 */
export const INKLINK_TIMESTAMP_HEADER = "X-Inklink-Timestamp";
export const INKLINK_SIGNATURE_HEADER = "X-Inklink-Signature";
export const CALLBACK_MAX_AGE_SECONDS = 300;

export interface PaymentSettledEvent {
  paymentId: string;
  jobId: string;
  /** Hedera account that actually paid (the agent wallet). */
  payerAccount: string;
  merchantAccountId: string; // "0.0.XXXXX"
  network: "hedera:testnet";
  asset: "HTS_USDC";
  amount: DecimalString;
  transactionId: string; // real, mirror-node-verified Hedera tx id
  settlementTimestamp: string; // ISO-8601, from mirror node consensus time
  status: "settled";
  /** Derived from the real transactionId. Never fabricated. */
  hashscanUrl: string;
}
