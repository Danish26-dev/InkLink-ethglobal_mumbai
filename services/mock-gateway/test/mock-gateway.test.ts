import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { PaymentSettledEvent } from "@inklink/shared-schemas";
import { canonicalJson } from "@inklink/shared-schemas";
import { verifyCallback } from "../src/callback-auth.js";
import { inrToUsdc } from "../src/fx.js";
import { SessionStore, buildQrPayload, createGatewayIdentity } from "../src/gateway-crypto.js";
// Interop: the REAL agent-side builder must produce requests this verifier accepts.
import { buildCallbackRequest, hashscanUrlFor } from "../../payment-agent/src/settlement.js";

describe("inrToUsdc (integer math, rounds UP, 6 decimals)", () => {
  it("converts exactly when the result is exact", () => {
    assert.equal(inrToUsdc("20.00", "0.005"), "0.10");
    assert.equal(inrToUsdc("1000.00", "0.0119"), "11.90");
  });

  it("rounds UP so the shop is never undercharged", () => {
    // 20 INR * 0.0119 = 0.238 -> exact; use a rate that is not.
    assert.equal(inrToUsdc("1.00", "0.0111111"), "0.011112"); // 0.0111111 -> ceil at 6dp
    assert.equal(inrToUsdc("0.01", "0.0119"), "0.000119");
    assert.equal(inrToUsdc("0.01", "0.00000001"), "0.000001"); // tiny but never zero
  });

  it("never uses floating point (0.1 + 0.2 style traps)", () => {
    assert.equal(inrToUsdc("0.30", "1"), "0.30");
    assert.equal(inrToUsdc("33.33", "0.01"), "0.3333");
  });

  it("rejects malformed or over-precise input", () => {
    assert.throws(() => inrToUsdc("abc", "0.005"));
    assert.throws(() => inrToUsdc("1.234", "0.005")); // INR has 2 decimals
    assert.throws(() => inrToUsdc("1.00", "0.0000000001")); // > 9 decimals
  });
});

describe("callback verification (what the real backend must do)", () => {
  const SECRET = "mock-callback-secret-1234567890";
  const event: PaymentSettledEvent = {
    paymentId: "payment_1", jobId: "job_1", payerAccount: "0.0.1001", merchantAccountId: "0.0.2002",
    network: "hedera:testnet", asset: "HTS_USDC", amount: "0.10",
    transactionId: "0.0.7162784@1700000000.000000001", settlementTimestamp: "2023-11-14T22:13:20.123Z",
    status: "settled", hashscanUrl: hashscanUrlFor("0.0.7162784@1700000000.000000001"),
  };
  const lower = (h: Record<string, string>) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));

  it("accepts exactly what the payment agent sends", () => {
    const { body, headers } = buildCallbackRequest(event, SECRET, 1_700_000_000_000);
    const r = verifyCallback(Buffer.from(body), lower(headers), SECRET, 1_700_000_000_000);
    assert.deepEqual(r, { ok: true });
  });

  it("rejects a body altered by even one byte", () => {
    const { body, headers } = buildCallbackRequest(event, SECRET, 1_700_000_000_000);
    const tampered = body.replace('"amount":"0.10"', '"amount":"0.01"');
    assert.notEqual(tampered, body);
    const r = verifyCallback(Buffer.from(tampered), lower(headers), SECRET, 1_700_000_000_000);
    assert.deepEqual(r, { ok: false, reason: "BAD_SIGNATURE" });
  });

  it("rejects the wrong secret, missing headers and stale timestamps", () => {
    const { body, headers } = buildCallbackRequest(event, SECRET, 1_700_000_000_000);
    assert.deepEqual(verifyCallback(Buffer.from(body), lower(headers), "other-secret-other-secret", 1_700_000_000_000), { ok: false, reason: "BAD_SIGNATURE" });
    assert.deepEqual(verifyCallback(Buffer.from(body), {}, SECRET), { ok: false, reason: "MISSING_HEADERS" });
    // 6 minutes later: replay window exceeded
    assert.deepEqual(verifyCallback(Buffer.from(body), lower(headers), SECRET, 1_700_000_000_000 + 360_000), { ok: false, reason: "STALE_TIMESTAMP" });
  });

  it("rejects a captured request replayed with a refreshed timestamp (timestamp is inside the MAC)", () => {
    const { body, headers } = buildCallbackRequest(event, SECRET, 1_700_000_000_000);
    const refreshed = { ...lower(headers), "x-inklink-timestamp": "1700000300" };
    assert.deepEqual(verifyCallback(Buffer.from(body), refreshed, SECRET, 1_700_000_300_000), { ok: false, reason: "BAD_SIGNATURE" });
  });
});

describe("gateway identity, QR and sessions", () => {
  it("signs a QR whose signature verifies against its own embedded key over canonical JSON", () => {
    const id = createGatewayIdentity();
    const qr = buildQrPayload(id, { shopId: "shop_001", gatewayId: "gateway_001", mdns: "g.local", ip: "192.168.1.20", port: 8000, ttlMs: 60_000 });
    const { signature, ...unsigned } = qr;
    const key = crypto.createPublicKey({
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(qr.publicKey, "base64url")]),
      format: "der", type: "spki",
    });
    assert.equal(crypto.verify(null, Buffer.from(canonicalJson(unsigned)), key, Buffer.from(signature, "base64url")), true);
  });

  it("omits the optional ip from the signed bytes when absent", () => {
    const id = createGatewayIdentity();
    const qr = buildQrPayload(id, { shopId: "s", gatewayId: "g", mdns: "g.local", port: 8000, ttlMs: 60_000 });
    assert.equal("ip" in JSON.parse(JSON.stringify(qr)).gateway, false);
  });

  it("issues unguessable sessions that expire", async () => {
    const store = new SessionStore(30);
    const a = store.issue();
    const b = store.issue();
    assert.notEqual(a.token, b.token);
    assert.ok(a.token.length >= 40);
    assert.equal(store.check(a.token), "ok");
    assert.equal(store.check("nope"), "missing");
    assert.equal(store.check(undefined), "missing");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(store.check(a.token), "expired");
  });
});
