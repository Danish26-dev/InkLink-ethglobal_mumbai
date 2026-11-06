/**
 * OfflinePay in the app: the phone checks its own limits before handing out a promise,
 * records only what the shop has (or may have), and frees its limit only on a verified
 * Hedera settlement reported by the backend.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OfflineLedger, OfflinePayError } from "@inklink/shared-schemas";
import { verifySignature } from "../src/crypto/ed25519";
import { buildOfflineVoucher } from "../src/crypto/offline-pay";
import {
  assertDeviceCanIssue,
  classifySubmitError,
  describeOfflineState,
  offlinePollDelayMs,
  syncDeviceLedger,
  type OfflineVoucherView,
} from "../src/offline/offline-pay-flow";

const NOW = new Date("2026-11-06T10:00:00.000Z");
const KEY = new Uint8Array(32).fill(9);
let n = 0;
const id = () => {
  const b = new Uint8Array(16);
  b[15] = ++n;
  return b;
};
const sign = (jobId: string, amount: string, merchantId = "shop_001") =>
  buildOfflineVoucher(KEY, { jobId, quoteId: `quote_${jobId}`, merchantId, amount }, id(), NOW);
const ledger = () => new OfflineLedger({ verify: verifySignature, now: () => NOW });
const code = (c: string) => (e: unknown) => e instanceof OfflinePayError && e.code === c;

function view(v: ReturnType<typeof sign>, over: Partial<OfflineVoucherView> = {}): OfflineVoucherView {
  const { signature, ...unsigned } = v;
  void signature;
  return { voucher: unsigned, state: "PENDING_SETTLEMENT", acceptedAt: NOW.toISOString(), updatedAt: NOW.toISOString(), settlementAttempts: 1, paymentId: "offpay_1", ...over };
}

describe("before signing: the phone's own limits", () => {
  it("checks without recording, so a refused promise never uses up the limit", () => {
    const l = ledger();
    const v = sign("job_a", "1.50");
    assertDeviceCanIssue(l, v, verifySignature, () => NOW);
    assert.equal(l.list().length, 0, "nothing recorded by the check");
  });

  it("refuses past the unsettled limit across all shops, and a second promise for one job", () => {
    const l = ledger();
    l.accept(sign("job_1", "2.00"));
    l.accept(sign("job_2", "2.00", "shop_002"));
    assert.throws(() => assertDeviceCanIssue(l, sign("job_3", "1.50", "shop_003"), verifySignature, () => NOW), code("OVER_OUTSTANDING_LIMIT"));
    assert.throws(() => assertDeviceCanIssue(l, sign("job_1", "0.10"), verifySignature, () => NOW), code("DUPLICATE_JOB"));
    assert.throws(() => assertDeviceCanIssue(l, sign("job_4", "2.01"), verifySignature, () => NOW), code("OVER_VOUCHER_LIMIT"));
  });

  it("refuses a voucher whose amount was changed after signing", () => {
    const v = { ...sign("job_t", "0.10"), amount: "0.01" };
    assert.throws(() => assertDeviceCanIssue(ledger(), v, verifySignature, () => NOW), code("SIGNATURE_INVALID"));
  });
});

describe("after sending", () => {
  it("only a network failure is 'unknown' (the shop may have it); any backend answer is a refusal", () => {
    assert.equal(classifySubmitError({ code: "GATEWAY_UNREACHABLE" }), "unknown");
    assert.equal(classifySubmitError({ code: "OVER_OUTSTANDING_LIMIT", status: 403 }), "refused");
    assert.equal(classifySubmitError({ code: "QUOTE_EXPIRED", status: 410 }), "refused");
    assert.equal(classifySubmitError(new Error("boom")), "refused");
  });

  it("frees the phone's limit only on a verified settlement from the backend", () => {
    const l = ledger();
    const v = sign("job_s", "2.00");
    l.accept(v);
    const key = v.devicePublicKey;
    assert.equal(l.outstanding(key), "2.000000");

    // Pending, failed and unresolved views change nothing: the shop is not paid yet.
    syncDeviceLedger(l, view(v));
    syncDeviceLedger(l, view(v, { state: "SETTLEMENT_FAILED", failureReason: "payment failed" }));
    syncDeviceLedger(l, view(v, { unresolved: true }));
    // "SETTLED" without a verified transaction is not enough either.
    syncDeviceLedger(l, view(v, { state: "SETTLED" }));
    assert.equal(l.outstanding(key), "2.000000");

    const tx = "0.0.7162784@1793992647.222766103";
    const settled = view(v, { state: "SETTLED", transactionId: tx, verifiedAt: "2026-11-06T10:05:00.000Z" });
    assert.equal(syncDeviceLedger(l, settled)?.state, "SETTLED");
    assert.equal(l.outstanding(key), "0.000000");
    assert.equal(syncDeviceLedger(l, settled)?.transactionId, tx, "idempotent");
  });

  it("ignores views for vouchers this phone never recorded", () => {
    assert.equal(syncDeviceLedger(ledger(), view(sign("job_x", "0.10"))), undefined);
  });
});

describe("what the customer is told", () => {
  const v = sign("job_d", "0.10");
  it("never calls a promise a payment until it is verified", () => {
    assert.equal(describeOfflineState(view(v, { state: "AUTHORIZED_OFFLINE" })).title, "Promise accepted");
    assert.match(describeOfflineState(view(v, { state: "AUTHORIZED_OFFLINE" })).detail, /not a payment yet/);
    assert.equal(describeOfflineState(view(v)).title, "Settling");
    assert.equal(describeOfflineState(view(v, { unresolved: true })).final, false);
    assert.equal(describeOfflineState(view(v, { state: "SETTLEMENT_FAILED" })).final, false, "the shop retries");
    const done = describeOfflineState(view(v, { state: "SETTLED", transactionId: "0.0.1@1.2", verifiedAt: "x" }));
    assert.equal(done.title, "Paid on Hedera");
    assert.equal(done.final, true);
  });

  it("keeps polling, backing off to 20 s after errors", () => {
    assert.deepEqual([0, 1, 2, 3, 4, 9].map(offlinePollDelayMs), [3000, 3000, 6000, 12000, 20000, 20000]);
  });
});
