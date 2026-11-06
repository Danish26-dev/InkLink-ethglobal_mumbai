import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_COPIES,
  clampCopies,
  hashscanTransactionUrl,
  paymentInProgressFor,
  paymentPollDelayMs,
  quoteExpired,
} from "../src/payment-flow";

describe("payment screen rules", () => {
  it("links HashScan with the mirror-node transaction id form", () => {
    assert.equal(
      hashscanTransactionUrl("0.0.7162784@1793986272.588926799"),
      "https://hashscan.io/testnet/transaction/0.0.7162784-1793986272-588926799",
    );
    assert.equal(
      hashscanTransactionUrl("0.0.7162784-1793986272-588926799"),
      "https://hashscan.io/testnet/transaction/0.0.7162784-1793986272-588926799",
    );
  });

  it("keeps copies within what the printer and backend accept", () => {
    assert.equal(clampCopies(0), 1);
    assert.equal(clampCopies(-3), 1);
    assert.equal(clampCopies(2.7), 2);
    assert.equal(clampCopies(MAX_COPIES + 1), 999);
    assert.equal(clampCopies(Number.NaN), 1);
  });

  it("treats a quote at or past its deadline (or unparseable) as expired", () => {
    const now = Date.parse("2026-11-06T17:00:00.000Z");
    assert.equal(quoteExpired({ expiresAt: "2026-11-06T17:00:01.000Z" }, now), false);
    assert.equal(quoteExpired({ expiresAt: "2026-11-06T17:00:00.000Z" }, now), true);
    assert.equal(quoteExpired({ expiresAt: "not a date" }, now), true);
  });

  it("returning to the approval screen reuses the payment for the same quote, never a new one", () => {
    const session = { paymentId: "payment_1", paidQuoteId: "quote_1" };
    assert.equal(paymentInProgressFor(session, "quote_1"), "payment_1");
    assert.equal(paymentInProgressFor(session, "quote_2"), undefined); // a new quote may be paid
    assert.equal(paymentInProgressFor({}, "quote_1"), undefined);
    assert.equal(paymentInProgressFor(session, undefined), undefined);
  });

  it("keeps polling after errors, backing off to 15 s", () => {
    assert.deepEqual([0, 1, 2, 3, 4, 10].map(paymentPollDelayMs), [2500, 2500, 5000, 10000, 15000, 15000]);
  });
});
