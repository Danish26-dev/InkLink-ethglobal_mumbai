import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PaymentPolicy } from "@inklink/shared-schemas";
import { checkPolicy } from "../src/policy.js";
import { addDecimal, compareDecimal, toSmallestUnit } from "../src/money.js";

const basePolicy: PaymentPolicy = {
  authorizationId: "auth_1",
  customerReference: "cust_1",
  agentId: "inklink_payment_agent",
  merchantAllowlist: ["shop_001"],
  maxPerTransaction: "50.00",
  totalSpendingLimit: "200.00",
  spentToDate: "0.00",
  asset: "USDC",
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  status: "active",
  createdAt: new Date().toISOString(),
};

describe("money", () => {
  it("parses decimals to smallest units", () => {
    assert.equal(toSmallestUnit("20.00", 6), 20_000_000n);
    assert.equal(toSmallestUnit("1.5", 6), 1_500_000n);
    assert.equal(toSmallestUnit("0.000001", 6), 1n);
  });

  it("rejects over-precise amounts", () => {
    assert.throws(() => toSmallestUnit("1.0000001", 6));
  });

  it("compares and adds without float error", () => {
    assert.equal(compareDecimal("0.10", "0.20", 6), -1);
    assert.equal(addDecimal("0.10", "0.20", 6), "0.300000");
  });
});

describe("policy", () => {
  it("allows a compliant payment", () => {
    const r = checkPolicy(basePolicy, { merchantId: "shop_001", amount: "20.00", asset: "USDC" });
    assert.equal(r.allowed, true);
  });

  it("blocks a non-allowlisted merchant", () => {
    const r = checkPolicy(basePolicy, { merchantId: "shop_999", amount: "20.00", asset: "USDC" });
    assert.equal(r.allowed, false);
    assert.equal(r.violation, "MERCHANT_NOT_ALLOWED");
  });

  it("blocks over per-transaction max", () => {
    const r = checkPolicy(basePolicy, { merchantId: "shop_001", amount: "60.00", asset: "USDC" });
    assert.equal(r.violation, "EXCEEDS_PER_TRANSACTION");
  });

  it("blocks over total limit given prior spend", () => {
    const policy = { ...basePolicy, spentToDate: "190.00" };
    const r = checkPolicy(policy, { merchantId: "shop_001", amount: "20.00", asset: "USDC" });
    assert.equal(r.violation, "EXCEEDS_TOTAL_LIMIT");
  });

  it("blocks wrong asset", () => {
    const r = checkPolicy(basePolicy, { merchantId: "shop_001", amount: "20.00", asset: "HBAR" });
    assert.equal(r.violation, "WRONG_ASSET");
  });

  it("blocks expired authorization", () => {
    const policy = { ...basePolicy, expiresAt: new Date(Date.now() - 1000).toISOString() };
    const r = checkPolicy(policy, { merchantId: "shop_001", amount: "20.00", asset: "USDC" });
    assert.equal(r.violation, "AUTHORIZATION_EXPIRED");
  });
});
