/**
 * Pairing with a device proof: the app signs its own challenge with the device key (noble);
 * a fake gateway that mirrors the backend verifies it with node:crypto and derives the stable
 * `native_dev_` identity exactly like services/backend/app/routes_native.py.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { base64urlEncode } from "@inklink/shared-schemas";
import { publicKeyFor, signMessage } from "../src/crypto/ed25519";
import {
  PairingError,
  buildDeviceProof,
  handshakeWithDevice,
  runHandshake,
  type DeviceProof,
} from "../src/discovery/pairing";

const shop = crypto.generateKeyPairSync("ed25519");
const shopPub = shop.publicKey.export({ format: "jwk" }).x as string;
const pinned = { publicKey: shopPub, gatewayId: "gateway_001" };

function deviceKey(fill: number) {
  const secret = new Uint8Array(32).fill(fill);
  return {
    publicKey: publicKeyFor(secret),
    prove: (challenge: string): DeviceProof => buildDeviceProof(challenge, (m) => signMessage(m, secret), publicKeyFor(secret)),
  };
}

const challenge = () => base64urlEncode(crypto.randomBytes(32));

/** Mirrors the backend: verify the device signature over the UTF-8 challenge, derive the ref. */
function backendGateway() {
  const seen: Array<Record<string, unknown>> = [];
  const impl = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    seen.push(body);
    let ref: string | undefined;
    if (body.devicePublicKey !== undefined || body.deviceSignature !== undefined) {
      const raw = Buffer.from(String(body.devicePublicKey), "base64url");
      const key = crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" });
      const ok = raw.length === 32 && crypto.verify(null, Buffer.from(body.challenge), key, Buffer.from(String(body.deviceSignature), "base64url"));
      if (!ok) {
        return new Response(JSON.stringify({ success: false, error: { code: "SIGNATURE_INVALID", message: "The device signature over the challenge did not verify." } }), { status: 401 });
      }
      ref = "native_dev_" + crypto.createHash("sha256").update(raw).digest("hex").slice(0, 24);
    }
    return new Response(JSON.stringify({
      signedChallenge: crypto.sign(null, Buffer.from(body.challenge), shop.privateKey).toString("base64url"),
      gatewayId: "gateway_001",
      sessionToken: crypto.randomBytes(24).toString("hex"),
      sessionExpiresAt: new Date(Date.now() + 900_000).toISOString(),
      ...(ref ? { customerReference: ref } : {}),
    }), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, seen };
}

describe("pairing with the device key", () => {
  it("sends a valid device signature and gets a stable native_dev_ identity", async () => {
    const gw = backendGateway();
    const dev = deviceKey(3);
    const s = await handshakeWithDevice("https://shop", pinned, challenge(), dev.prove, undefined, gw.impl);
    assert.match(s.customerReference ?? "", /^native_dev_[0-9a-f]{24}$/);
    assert.equal(gw.seen[0].devicePublicKey, dev.publicKey);
    assert.equal(typeof gw.seen[0].deviceSignature, "string");
  });

  it("keeps the same identity across session renewals, and another device gets another one", async () => {
    const gw = backendGateway();
    const dev = deviceKey(3);
    const first = await handshakeWithDevice("https://shop", pinned, challenge(), dev.prove, undefined, gw.impl);
    const renewed = await handshakeWithDevice("https://shop", pinned, challenge(), dev.prove, first.customerReference, gw.impl);
    assert.equal(renewed.customerReference, first.customerReference);
    assert.notEqual(renewed.sessionToken, first.sessionToken);

    const other = await handshakeWithDevice("https://shop", pinned, challenge(), deviceKey(4).prove, undefined, gw.impl);
    assert.notEqual(other.customerReference, first.customerReference);
  });

  it("refuses a renewal that comes back with a different identity", async () => {
    const gw = backendGateway();
    await assert.rejects(
      handshakeWithDevice("https://shop", pinned, challenge(), deviceKey(3).prove, "native_dev_000000000000000000000000", gw.impl),
      (e: unknown) => e instanceof PairingError && /different customer identity/.test(e.message),
    );
  });

  it("surfaces the backend's refusal of a bad device signature", async () => {
    const gw = backendGateway();
    const forged = (c: string): DeviceProof => ({ ...deviceKey(3).prove(c), devicePublicKey: deviceKey(4).publicKey });
    await assert.rejects(
      handshakeWithDevice("https://shop", pinned, challenge(), forged, undefined, gw.impl),
      (e: unknown) => e instanceof PairingError && e.code === "PAIRING_FAILED" && /did not verify/.test(e.message),
    );
  });

  it("the device key only ever signs an app-generated challenge", () => {
    const dev = deviceKey(3);
    for (const notAChallenge of ['{"type":"inklink_payment_authorization"}', "short", challenge() + "x", "a".repeat(42) + "+"]) {
      assert.throws(() => dev.prove(notAChallenge), PairingError);
    }
    assert.doesNotThrow(() => dev.prove(challenge()));
  });

  it("still pairs with a gateway that has no device-proof support", async () => {
    const gw = backendGateway();
    const s = await runHandshake("https://shop", pinned, challenge(), gw.impl);
    assert.equal(s.customerReference, undefined);
    assert.equal("devicePublicKey" in gw.seen[0], false);
  });

  it("rejects a malformed customer reference from the gateway", async () => {
    const impl = (async (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        signedChallenge: crypto.sign(null, Buffer.from(body.challenge), shop.privateKey).toString("base64url"),
        gatewayId: "gateway_001", sessionToken: "x".repeat(32),
        sessionExpiresAt: new Date(Date.now() + 900_000).toISOString(), customerReference: "someone_else",
      }), { status: 200 });
    }) as unknown as typeof fetch;
    await assert.rejects(handshakeWithDevice("https://shop", pinned, challenge(), deviceKey(3).prove, undefined, impl), /invalid customer reference/);
  });
});
