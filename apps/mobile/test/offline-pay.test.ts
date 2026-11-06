/**
 * OfflinePay: the device signs with noble (as in the app); the shop verifies with Node's
 * independent Ed25519 implementation. Covers verification, limits, nonce/replay, duplicates,
 * persistence across restarts and reconciliation against a verified settlement.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  DEFAULT_OFFLINE_PAY_POLICY,
  MemoryOfflineLedgerStorage,
  OfflineLedger,
  OfflinePayError,
  jsonTextStorage,
  offlineVoucherSigningText,
  verifyOfflineVoucher,
  type OfflineSettlementOutcome,
} from "@inklink/shared-schemas";
import { verifySignature } from "../src/crypto/ed25519";
import { buildOfflineVoucher, issueOfflineVoucher } from "../src/crypto/offline-pay";

/** Shop-side verifier: Node's crypto, not noble. */
function nodeVerify(message: string, signature: string, publicKey: string): boolean {
  try {
    const key = crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey }, format: "jwk" });
    return crypto.verify(null, Buffer.from(message), key, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

const NOW = new Date("2026-11-06T10:00:00.000Z");
const DEVICE = new Uint8Array(32).fill(7);
const OTHER_DEVICE = new Uint8Array(32).fill(8);
let idCounter = 0;
const nextId = () => {
  const b = new Uint8Array(16);
  b[15] = ++idCounter;
  return b;
};

const fields = (over: Partial<{ jobId: string; amount: string; merchantId: string; validForMs: number }> = {}) => ({
  jobId: `job_${idCounter + 1}`,
  quoteId: "quote_1",
  merchantId: "shop_001",
  amount: "0.10",
  ...over,
});

function shop(clock = { now: NOW }) {
  return new OfflineLedger({ verify: nodeVerify, merchantId: "shop_001", now: () => clock.now });
}

const code = (c: string) => (e: unknown) => e instanceof OfflinePayError && e.code === c;

const settled = (jobId: string, amount = "0.10", tx = "0.0.7162784@1793916490.190691897"): OfflineSettlementOutcome => ({
  jobId,
  paymentId: "payment_1",
  paymentStatus: "SETTLED",
  amount,
  transactionId: tx,
  transactionVerified: true,
  verifiedAt: "2026-11-06T11:00:00.000Z",
});

describe("offline voucher verification (noble signs, Node verifies)", () => {
  it("accepts a correctly signed voucher", () => {
    const v = buildOfflineVoucher(DEVICE, fields(), nextId(), NOW);
    const { record, duplicate } = shop().accept(v);
    assert.equal(record.state, "AUTHORIZED_OFFLINE");
    assert.equal(duplicate, false);
    assert.equal(record.transactionId, undefined, "an offline authorization never carries a transaction id");
  });

  it("refuses a tampered amount, job or merchant", () => {
    const v = buildOfflineVoucher(DEVICE, fields(), nextId(), NOW);
    for (const tamper of [{ amount: "0.01" }, { jobId: "job_other" }, { quoteId: "quote_9" }]) {
      assert.throws(() => shop().accept({ ...v, ...tamper }), code("SIGNATURE_INVALID"));
    }
  });

  it("refuses a voucher signed by another device than the key it claims", () => {
    const v = buildOfflineVoucher(DEVICE, fields(), nextId(), NOW);
    const forged = buildOfflineVoucher(OTHER_DEVICE, fields(), nextId(), NOW);
    assert.throws(() => shop().accept({ ...v, signature: forged.signature }), code("SIGNATURE_INVALID"));
  });

  it("refuses a voucher for another shop", () => {
    const v = buildOfflineVoucher(DEVICE, fields({ merchantId: "shop_999" }), nextId(), NOW);
    assert.throws(() => shop().accept(v), code("WRONG_MERCHANT"));
  });

  it("enforces expiry, future issue time and maximum validity", () => {
    const v = buildOfflineVoucher(DEVICE, fields({ validForMs: 60_000 }), nextId(), NOW);
    assert.throws(() => shop({ now: new Date(NOW.getTime() + 61_000) }).accept(v), code("EXPIRED"));

    const future = buildOfflineVoucher(DEVICE, fields(), nextId(), new Date(NOW.getTime() + 10 * 60_000));
    assert.throws(() => shop().accept(future), code("NOT_YET_VALID"));

    const tooLong = buildOfflineVoucher(DEVICE, fields({ validForMs: 3 * 60 * 60_000 }), nextId(), NOW);
    assert.throws(() => shop().accept(tooLong), code("VALIDITY_TOO_LONG"));
  });

  it("refuses amounts over the per-voucher limit, zero, or malformed", () => {
    assert.throws(() => shop().accept(buildOfflineVoucher(DEVICE, fields({ amount: "2.01" }), nextId(), NOW)), code("OVER_VOUCHER_LIMIT"));
    assert.throws(() => shop().accept(buildOfflineVoucher(DEVICE, fields({ amount: "0" }), nextId(), NOW)), code("AMOUNT_INVALID"));
    assert.throws(() => shop().accept(buildOfflineVoucher(DEVICE, fields({ amount: "0.1234567" }), nextId(), NOW)), code("AMOUNT_INVALID"));
  });

  it("refuses unknown fields, wrong type and a forged customer reference", () => {
    const v = buildOfflineVoucher(DEVICE, fields(), nextId(), NOW);
    assert.throws(() => shop().accept({ ...v, extra: "x" }), code("INVALID_VOUCHER"));
    assert.throws(() => shop().accept({ ...v, type: "inklink_payment_authorization" }), code("INVALID_VOUCHER"));
    assert.throws(() => shop().accept("not a voucher"), code("INVALID_VOUCHER"));
    assert.throws(
      () => verifyOfflineVoucher({ ...v, customerReference: "dev_someone_else_xxxxx" }, { verify: () => true, now: NOW }),
      code("INVALID_VOUCHER"),
    );
  });
});

describe("limits, replay and duplicates", () => {
  it("caps the unsettled total per device; settling frees it", () => {
    const ledger = shop();
    const big = (n: number) => buildOfflineVoucher(DEVICE, fields({ jobId: `job_cap_${n}`, amount: "2.00" }), nextId(), NOW);
    const a = big(1);
    ledger.accept(a);
    ledger.accept(big(2));
    assert.equal(ledger.outstanding(a.devicePublicKey), "4.000000");
    assert.throws(() => ledger.accept(big(3)), code("OVER_OUTSTANDING_LIMIT"));

    ledger.markPendingSettlement(a.voucherId, "payment_1");
    ledger.reconcile(a.voucherId, settled(a.jobId, "2.00"));
    assert.equal(ledger.outstanding(a.devicePublicKey), "2.000000");
    ledger.accept(big(4));
  });

  it("treats the identical voucher twice as one, and refuses a reused id with new content", () => {
    const ledger = shop();
    const v = buildOfflineVoucher(DEVICE, fields(), nextId(), NOW);
    ledger.accept(v);
    assert.equal(ledger.accept(v).duplicate, true);
    assert.equal(ledger.list().length, 1);
    assert.equal(ledger.outstanding(v.devicePublicKey), "0.100000");

    const reused = buildOfflineVoucher(DEVICE, fields({ amount: "0.20", jobId: "job_reuse" }), new Uint8Array(Buffer.from(v.voucherId, "base64url")), NOW);
    assert.throws(() => ledger.accept(reused), code("REPLAYED"));
  });

  it("refuses a second voucher for the same job", () => {
    const ledger = shop();
    ledger.accept(buildOfflineVoucher(DEVICE, fields({ jobId: "job_dup" }), nextId(), NOW));
    assert.throws(() => ledger.accept(buildOfflineVoucher(DEVICE, fields({ jobId: "job_dup" }), nextId(), NOW)), code("DUPLICATE_JOB"));
  });

  it("the device refuses to sign past its own limit, across shops", () => {
    const device = new OfflineLedger({ verify: verifySignature, now: () => NOW });
    issueOfflineVoucher(device, DEVICE, fields({ jobId: "j1", amount: "2.00" }), nextId(), NOW);
    issueOfflineVoucher(device, DEVICE, fields({ jobId: "j2", amount: "2.00", merchantId: "shop_002" }), nextId(), NOW);
    assert.throws(
      () => issueOfflineVoucher(device, DEVICE, fields({ jobId: "j3", amount: "1.50", merchantId: "shop_003" }), nextId(), NOW),
      code("OVER_OUTSTANDING_LIMIT"),
    );
    assert.equal(device.list().length, 2);
  });
});

describe("reconciliation against the online x402 settlement", () => {
  function pending() {
    const ledger = shop();
    const v = buildOfflineVoucher(DEVICE, fields(), nextId(), NOW);
    ledger.accept(v);
    ledger.markPendingSettlement(v.voucherId, "payment_1");
    return { ledger, v };
  }

  it("only becomes SETTLED with a verified, matching Hedera transaction", () => {
    const { ledger, v } = pending();
    assert.throws(() => ledger.reconcile(v.voucherId, { ...settled(v.jobId), transactionVerified: false }), code("SETTLEMENT_MISMATCH"));
    assert.throws(() => ledger.reconcile(v.voucherId, { ...settled(v.jobId), transactionId: null }), code("SETTLEMENT_MISMATCH"));
    assert.throws(() => ledger.reconcile(v.voucherId, { ...settled(v.jobId), transactionId: "0xdeadbeef" }), code("SETTLEMENT_MISMATCH"));
    assert.throws(() => ledger.reconcile(v.voucherId, settled(v.jobId, "0.09")), code("SETTLEMENT_MISMATCH"));
    assert.throws(() => ledger.reconcile(v.voucherId, settled("job_other")), code("SETTLEMENT_MISMATCH"));
    assert.throws(() => ledger.reconcile(v.voucherId, { ...settled(v.jobId), paymentId: "payment_other" }), code("SETTLEMENT_MISMATCH"));
    assert.equal(ledger.get(v.voucherId)?.state, "PENDING_SETTLEMENT", "rejected outcomes change nothing");

    const r = ledger.reconcile(v.voucherId, settled(v.jobId, "0.100000"));
    assert.equal(r.state, "SETTLED");
    assert.equal(r.transactionId, "0.0.7162784@1793916490.190691897");
  });

  it("re-applying the same settlement is idempotent; a different transaction is refused", () => {
    const { ledger, v } = pending();
    ledger.reconcile(v.voucherId, settled(v.jobId));
    assert.equal(ledger.reconcile(v.voucherId, settled(v.jobId)).state, "SETTLED");
    assert.throws(() => ledger.reconcile(v.voucherId, settled(v.jobId, "0.10", "0.0.1@1.2")), code("SETTLEMENT_MISMATCH"));
  });

  it("a failed settlement keeps the debt outstanding and can be retried", () => {
    const { ledger, v } = pending();
    const failed = ledger.reconcile(v.voucherId, {
      jobId: v.jobId, paymentStatus: "FAILED", amount: "0.10", transactionId: null,
      transactionVerified: false, verifiedAt: null, failureReason: "facilitator rejected",
    });
    assert.equal(failed.state, "SETTLEMENT_FAILED");
    assert.equal(ledger.outstanding(v.devicePublicKey), "0.100000");
    assert.deepEqual(ledger.pendingForSync().map((r) => r.voucher.voucherId), [v.voucherId]);

    const retry = ledger.markPendingSettlement(v.voucherId, "payment_1");
    assert.equal(retry.settlementAttempts, 2);
    assert.equal(ledger.reconcile(v.voucherId, settled(v.jobId)).state, "SETTLED");
    assert.equal(ledger.pendingForSync().length, 0);
  });

  it("cannot reconcile before settlement starts, nor an unknown voucher", () => {
    const ledger = shop();
    const v = buildOfflineVoucher(DEVICE, fields(), nextId(), NOW);
    ledger.accept(v);
    assert.throws(() => ledger.reconcile(v.voucherId, settled(v.jobId)), code("INVALID_TRANSITION"));
    assert.throws(() => ledger.reconcile("nope", settled(v.jobId)), code("UNKNOWN_VOUCHER"));
  });
});

describe("persistence", () => {
  it("remembers vouchers, nonces and debt across a restart", () => {
    const storage = new MemoryOfflineLedgerStorage();
    const first = new OfflineLedger({ verify: nodeVerify, merchantId: "shop_001", storage, now: () => NOW });
    const v = buildOfflineVoucher(DEVICE, fields({ jobId: "job_persist" }), nextId(), NOW);
    first.accept(v);

    const restarted = new OfflineLedger({ verify: nodeVerify, merchantId: "shop_001", storage, now: () => NOW });
    assert.equal(restarted.get(v.voucherId)?.state, "AUTHORIZED_OFFLINE");
    assert.equal(restarted.outstanding(v.devicePublicKey), "0.100000");
    assert.equal(restarted.accept(v).duplicate, true, "replay after restart is still caught");
  });

  it("a failed save changes nothing", () => {
    let fail = false;
    const inner = new MemoryOfflineLedgerStorage();
    const storage = { load: () => inner.load(), save: (r: Parameters<typeof inner.save>[0]) => { if (fail) throw new Error("disk full"); inner.save(r); } };
    const ledger = new OfflineLedger({ verify: nodeVerify, merchantId: "shop_001", storage, now: () => NOW });
    fail = true;
    assert.throws(() => ledger.accept(buildOfflineVoucher(DEVICE, fields(), nextId(), NOW)), /disk full/);
    assert.equal(ledger.list().length, 0);
  });

  it("refuses to start on a corrupt ledger file instead of forgetting debt", () => {
    for (const text of ["{ broken", JSON.stringify({ version: 2, records: [] }), JSON.stringify({ records: "x" })]) {
      assert.throws(
        () => new OfflineLedger({ verify: nodeVerify, storage: jsonTextStorage({ read: () => text, write: () => {} }) }),
        code("STORAGE_CORRUPT"),
      );
    }
    let saved = "";
    const io = { read: () => saved || null, write: (t: string) => { saved = t; } };
    const ledger = new OfflineLedger({ verify: nodeVerify, merchantId: "shop_001", storage: jsonTextStorage(io), now: () => NOW });
    ledger.accept(buildOfflineVoucher(DEVICE, fields({ jobId: "job_file" }), nextId(), NOW));
    assert.equal(new OfflineLedger({ verify: nodeVerify, storage: jsonTextStorage(io) }).list().length, 1);
  });
});

describe("published OfflinePay vector", () => {
  it("is deterministic, so other implementations can check their bytes", () => {
    const id = new Uint8Array(16).fill(1);
    const v = buildOfflineVoucher(new Uint8Array(32).fill(9), { jobId: "job_vector", quoteId: "quote_vector", merchantId: "shop_001", amount: "0.10" }, id, NOW);
    assert.ok(nodeVerify(offlineVoucherSigningText(v), v.signature, v.devicePublicKey));
    assert.equal(v.voucherId, "AQEBAQEBAQEBAQEBAQEBAQ");
    assert.equal(v.expiresAt, "2026-11-06T10:30:00.000Z");
    assert.equal(DEFAULT_OFFLINE_PAY_POLICY.maxOutstanding, "5.00");
    // Pinned; also verified independently in Python (docs/API_CONTRACTS.md).
    assert.equal(
      v.signature,
      "cUvdzz9y-8K1IT0U4b89ZzSvasw9bLeTjooCpszEbDF6I3x6yHJI9J7-CP5FgsFpUQ1kE1moD6xG8qV0iDl-AQ",
    );
    // Same inputs always give the same signature (Ed25519 is deterministic).
    assert.equal(buildOfflineVoucher(new Uint8Array(32).fill(9), { jobId: "job_vector", quoteId: "quote_vector", merchantId: "shop_001", amount: "0.10" }, id, NOW).signature, v.signature);
  });
});
