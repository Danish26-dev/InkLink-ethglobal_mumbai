/**
 * Interop: an authorization built by the MOBILE APP's code (noble Ed25519) must be
 * accepted by the payment agent's REAL verifier (Node crypto). This imports the
 * app's pure crypto module directly, so a drift in either side's wire format fails
 * here rather than on a phone.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { base64urlEncode } from "@inklink/shared-schemas";
import { buildSignedAuthorization } from "../../../apps/mobile/src/crypto/authorization";
import { verifyAuthorizationSignature } from "../src/device-auth.js";

const secret = Uint8Array.from({ length: 32 }, (_, i) => (i * 11 + 3) & 255);
const fields = {
  agentId: "inklink_payment_agent",
  merchantId: "shop_001",
  maxPerTransaction: "1.00",
  totalSpendingLimit: "5.00",
  asset: "USDC" as const,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};
const nonce = Uint8Array.from({ length: 16 }, (_, i) => 200 - i);

describe("app -> agent authorization interop", () => {
  it("the agent accepts a request built by the app", () => {
    const req = buildSignedAuthorization(secret, fields, nonce);
    assert.deepEqual(verifyAuthorizationSignature(req, "inklink_payment_agent"), { ok: true });
    assert.equal(req.nonce, base64urlEncode(nonce));
  });

  it("the agent rejects the same request once any signed field is altered", () => {
    const req = buildSignedAuthorization(secret, fields, nonce);
    for (const tampered of [
      { ...req, maxPerTransaction: "100.00" },
      { ...req, merchantId: "shop_999" },
      { ...req, expiresAt: new Date(Date.now() + 7_200_000).toISOString() },
      { ...req, asset: "USDC" as const, nonce: base64urlEncode(Uint8Array.from({ length: 16 }, () => 1)) },
    ]) {
      const result = verifyAuthorizationSignature(tampered, "inklink_payment_agent");
      assert.equal(result.ok, false);
    }
  });
});
