/**
 * Small, pure rules for the payment screens, kept here so they can be tested without a phone.
 */

import type { Quote } from "@inklink/shared-schemas";

/** The printer adapter's limit; the backend refuses more (Contract 3). */
export const MAX_COPIES = 999;

export function clampCopies(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.min(MAX_COPIES, Math.max(1, Math.trunc(n)));
}

/**
 * HashScan link for a Hedera transaction id. The SDK form `0.0.x@secs.nanos` does not resolve
 * on HashScan; it needs the mirror-node form `0.0.x-secs-nanos` (as the payment agent builds).
 */
export function hashscanTransactionUrl(transactionId: string): string {
  const id = transactionId.includes("@")
    ? (() => {
        const [payer, ts] = transactionId.split("@");
        return `${payer}-${ts.replace(".", "-")}`;
      })()
    : transactionId;
  return `https://hashscan.io/testnet/transaction/${encodeURIComponent(id)}`;
}

/** A quote is payable only before its deadline (the backend and agent enforce it too). */
export function quoteExpired(quote: Pick<Quote, "expiresAt">, nowMs: number = Date.now()): boolean {
  const t = Date.parse(quote.expiresAt);
  return Number.isNaN(t) || t <= nowMs;
}

/**
 * The payment already started for this exact quote, if any. Returning to the approval screen
 * (Android Back) must show that payment instead of authorizing and paying a second time.
 */
export function paymentInProgressFor(
  session: { paymentId?: string; paidQuoteId?: string },
  quoteId: string | undefined,
): string | undefined {
  return quoteId && session.paidQuoteId === quoteId ? session.paymentId : undefined;
}

/** Status polling: 2.5 s normally; after errors back off to at most 15 s, never give up. */
export function paymentPollDelayMs(consecutiveErrors: number): number {
  if (consecutiveErrors <= 0) return 2500;
  return Math.min(15_000, 2500 * 2 ** (consecutiveErrors - 1));
}
