/**
 * Settlement verification + the signed PaymentSettledEvent sent to the backend.
 *
 * Hard rule: a facilitator SettleResponse with a transaction id is a claim, not
 * proof. We verify against the Hedera testnet mirror node that the transaction
 * SUCCEEDED and that it actually moved the expected HTS token amount to the
 * expected merchant account. Only then do we mark `settled` and notify the
 * backend, which owns the authoritative job status.
 */

import crypto from "node:crypto";
import {
  INKLINK_SIGNATURE_HEADER,
  INKLINK_TIMESTAMP_HEADER,
  type PaymentSettledEvent,
} from "@inklink/shared-schemas";

const MIRROR_BASE = "https://testnet.mirrornode.hedera.com/api/v1";

export interface ExpectedTransfer {
  tokenId: string;
  /** Merchant account that must have received the funds. */
  payTo: string;
  /** Exact amount in the token's smallest unit. */
  amountAtomic: bigint;
}

interface MirrorTokenTransfer {
  token_id: string;
  account: string;
  amount: number;
}

interface MirrorTransaction {
  result?: string;
  consensus_timestamp?: string;
  token_transfers?: MirrorTokenTransfer[];
}

/**
 * Convert an SDK-style id ("0.0.x@secs.nanos") to the mirror node's form
 * ("0.0.x-secs-nanos"). Already-normalised ids pass through unchanged.
 */
export function toMirrorTransactionId(transactionId: string): string {
  if (!transactionId.includes("@")) return transactionId;
  const [payer, ts] = transactionId.split("@");
  return `${payer}-${ts.replace(".", "-")}`;
}

/** Pure check, separated out so it can be unit tested without the network. */
export function transactionMatches(
  tx: MirrorTransaction,
  expected: ExpectedTransfer,
): boolean {
  if (tx.result !== "SUCCESS") return false;
  return (tx.token_transfers ?? []).some(
    (t) =>
      t.token_id === expected.tokenId &&
      t.account === expected.payTo &&
      BigInt(t.amount) === expected.amountAtomic,
  );
}

export interface VerifiedSettlement {
  verified: boolean;
  consensusTimestamp?: string;
}

/**
 * Verify the transaction on the mirror node. Mirror ingestion lags a few
 * seconds behind consensus, so a not-yet-visible transaction returns
 * `verified: false` and callers should retry.
 */
export async function verifyOnChain(
  transactionId: string,
  expected: ExpectedTransfer,
): Promise<VerifiedSettlement> {
  let body: { transactions?: MirrorTransaction[] };
  try {
    const res = await fetch(
      `${MIRROR_BASE}/transactions/${toMirrorTransactionId(transactionId)}`,
    );
    if (!res.ok) return { verified: false };
    body = (await res.json()) as { transactions?: MirrorTransaction[] };
  } catch {
    // A network error says nothing about whether the transfer happened. Treat it as
    // "not confirmed yet" so the caller retries and, if it never confirms, keeps the
    // spend reserved. It must never look like "no payment was made".
    return { verified: false };
  }
  const match = (body.transactions ?? []).find((tx) => transactionMatches(tx, expected));
  return match
    ? { verified: true, consensusTimestamp: match.consensus_timestamp }
    : { verified: false };
}

/** Retry wrapper for mirror-node ingestion lag. */
export async function verifyOnChainWithRetry(
  transactionId: string,
  expected: ExpectedTransfer,
  attempts = 8,
  delayMs = 2500,
): Promise<VerifiedSettlement> {
  for (let i = 0; i < attempts; i++) {
    const result = await verifyOnChain(transactionId, expected);
    if (result.verified) return result;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return { verified: false };
}

/** https://hashscan.io link derived from a REAL transaction id (never fabricated). */
export function hashscanUrlFor(transactionId: string): string {
  return `https://hashscan.io/testnet/transaction/${toMirrorTransactionId(transactionId)}`;
}

/**
 * HMAC-SHA256 over `${timestamp}.${rawBody}`, hex, prefixed `sha256=`. The
 * timestamp is inside the MAC so a captured callback cannot be replayed with a
 * fresh timestamp. The backend recomputes this over the RAW request bytes.
 */
export function signCallback(rawBody: string, timestamp: string, secret: string): string {
  return (
    "sha256=" +
    crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")
  );
}

export function buildCallbackRequest(
  event: PaymentSettledEvent,
  secret: string,
  nowMs: number = Date.now(),
): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify(event);
  const timestamp = Math.floor(nowMs / 1000).toString();
  return {
    body,
    headers: {
      "Content-Type": "application/json",
      [INKLINK_TIMESTAMP_HEADER]: timestamp,
      [INKLINK_SIGNATURE_HEADER]: signCallback(body, timestamp, secret),
      // paymentId is the idempotency key: duplicates must not create duplicate
      // settlement records or trigger duplicate printer execution.
      "Idempotency-Key": event.paymentId,
    },
  };
}

export interface DeliveryOptions {
  url: string;
  secret: string;
  maxAttempts: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  onAttempt?: (attempt: number, outcome: string) => void;
}

export interface DeliveryResult {
  delivered: boolean;
  attempts: number;
  lastStatus?: number;
  lastError?: string;
}

/** Transient failures worth retrying. Other 4xx mean misconfiguration: stop. */
export function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

/**
 * Deliver the settlement callback with exponential backoff (1s, 2s, 4s … capped)
 * and ±20% jitter. Each attempt is re-signed with a fresh timestamp so a long
 * retry window never trips the backend's 5-minute freshness check. Retries stop on
 * any 2xx (the backend treats duplicates as success) or a non-retryable 4xx.
 */
export async function deliverCallback(
  event: PaymentSettledEvent,
  opts: DeliveryOptions,
): Promise<DeliveryResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const base = opts.baseDelayMs ?? 1000;
  const cap = opts.maxDelayMs ?? 30_000;
  let last: DeliveryResult = { delivered: false, attempts: 0 };

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    const { body, headers } = buildCallbackRequest(event, opts.secret);
    try {
      const res = await doFetch(opts.url, { method: "POST", headers, body });
      last = { delivered: false, attempts: attempt, lastStatus: res.status };
      if (res.ok) {
        opts.onAttempt?.(attempt, `delivered (${res.status})`);
        return { ...last, delivered: true };
      }
      opts.onAttempt?.(attempt, `HTTP ${res.status}`);
      if (!isRetryableStatus(res.status)) return last; // e.g. 401/400: retrying won't help
    } catch (err) {
      last = {
        delivered: false,
        attempts: attempt,
        lastError: err instanceof Error ? err.message : String(err),
      };
      opts.onAttempt?.(attempt, `network error: ${last.lastError}`);
    }
    if (attempt < opts.maxAttempts) {
      const delay = Math.min(cap, base * 2 ** (attempt - 1));
      await sleep(delay * (0.8 + Math.random() * 0.4));
    }
  }
  return last;
}
