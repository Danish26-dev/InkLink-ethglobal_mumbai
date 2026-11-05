/**
 * Published interop test vectors (docs/API_CONTRACTS.md). Any implementation — the
 * Python backend included — must reproduce these bytes exactly. These tests pin the
 * documented values so the docs and the code cannot drift apart.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  authorizationSigningPayload,
  base64urlDecode,
  canonicalJson,
  customerReferenceFor,
} from "@inklink/shared-schemas";
import { verifyEd25519 } from "../src/device-auth.js";
import { signCallback } from "../src/settlement.js";

const utf8 = (s: string) => new TextEncoder().encode(s);
const verify = (msg: string, sig: string, pub: string) =>
  verifyEd25519(utf8(msg), base64urlDecode(sig), base64urlDecode(pub));

export const VECTORS = {
  gatewayPublicKey: "ebVWLo_mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ",
  qrCanonical:
    '{"expiresAt":"2030-01-01T00:00:00.000Z","gateway":{"discovery":"local","ip":"192.168.1.20","mdns":"gateway-001.local","port":8000},"gatewayId":"gateway_001","nonce":"AAECAwQFBgcICQoL","publicKey":"ebVWLo_mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ","shopId":"shop_001","type":"inklink_shop","version":"1.0"}',
  qrSignature:
    "w2YMAQjC9utmmpS7z_Tnxm9HxrYdDkDyQrunujR761f79w2TrD7cXidRUDPPozmGAUh7PSJfND1io_8_n6McAQ",
  challenge: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
  challengeSignature:
    "lz3N-oxfN0f_KDlpeh0UvEhCzn_iG0Aznh-wEUfZq-9Y_Pp5BecE3Ay-BIkuJiF0KV1Y7WZA-F-tsysP5VYZAQ",
  callbackSecret: "test-secret-0123456789abcdef",
  callbackTimestamp: "1700000000",
  callbackBody: '{"paymentId":"payment_1","jobId":"job_1","amount":"0.10"}',
  callbackSignature: "sha256=47e949af76798bac7c53f33164612740179350ac8897c06c18e4142d8526d43c",
  devicePublicKey: "uvxxvq06xeS2PpyCFu5xo0quxlci7tvKcotOmzzM45Y",
  customerReference: "dev_uvxxvq06xeS2PpyCFu5xo0",
  authCanonical:
    '{"agentId":"inklink_payment_agent","asset":"USDC","customerReference":"dev_uvxxvq06xeS2PpyCFu5xo0","devicePublicKey":"uvxxvq06xeS2PpyCFu5xo0quxlci7tvKcotOmzzM45Y","expiresAt":"2030-01-01T00:00:00.000Z","maxPerTransaction":"1.00","merchantId":"shop_001","nonce":"AAECAwQFBgcICQoLDA0ODw","totalSpendingLimit":"5.00","type":"inklink_payment_authorization","version":"1.0"}',
  authSignature:
    "AzKuH4zCyXc5tHL6wxwIpOArKNRVSu-4jPObogtWM_ZRVdPxAtmPCj8YFQQLhCzHxV2uvYhPHqHr-cRa6IbrCA",
};

describe("published interop vectors", () => {
  it("QR: canonical JSON reproduces the documented string and the signature verifies", () => {
    const unsigned = JSON.parse(VECTORS.qrCanonical); // key order here is irrelevant
    assert.equal(canonicalJson(unsigned), VECTORS.qrCanonical);
    assert.equal(verify(VECTORS.qrCanonical, VECTORS.qrSignature, VECTORS.gatewayPublicKey), true);
  });

  it("pairing: the gateway's signature over the exact challenge string verifies", () => {
    assert.equal(verify(VECTORS.challenge, VECTORS.challengeSignature, VECTORS.gatewayPublicKey), true);
    assert.equal(verify(VECTORS.challenge + "A", VECTORS.challengeSignature, VECTORS.gatewayPublicKey), false);
  });

  it("callback: HMAC over `${timestamp}.${rawBody}` reproduces the documented value", () => {
    assert.equal(
      signCallback(VECTORS.callbackBody, VECTORS.callbackTimestamp, VECTORS.callbackSecret),
      VECTORS.callbackSignature,
    );
  });

  it("authorization: canonical payload, customerReference and signature all match", () => {
    assert.equal(customerReferenceFor(VECTORS.devicePublicKey), VECTORS.customerReference);
    const payload = authorizationSigningPayload({
      customerReference: VECTORS.customerReference,
      agentId: "inklink_payment_agent",
      merchantId: "shop_001",
      maxPerTransaction: "1.00",
      totalSpendingLimit: "5.00",
      asset: "USDC",
      nonce: "AAECAwQFBgcICQoLDA0ODw",
      expiresAt: "2030-01-01T00:00:00.000Z",
      devicePublicKey: VECTORS.devicePublicKey,
    });
    assert.equal(canonicalJson(payload), VECTORS.authCanonical);
    assert.equal(verify(VECTORS.authCanonical, VECTORS.authSignature, VECTORS.devicePublicKey), true);
  });
});
