/**
 * The app's crypto and discovery code, tested against an INDEPENDENT Ed25519
 * implementation (Node's built-in crypto) standing in for the shop gateway. If
 * these pass, a gateway written in any language that follows the documented wire
 * format will interoperate.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  base64urlEncode,
  canonicalJson,
  type ShopQrPayload,
} from "@inklink/shared-schemas";
import { buildSignedAuthorization } from "../src/crypto/authorization";
import { publicKeyFingerprint, publicKeyFor, signMessage, verifySignature } from "../src/crypto/ed25519";
import { PairingError, pickReachableOrigin, runHandshake } from "../src/discovery/pairing";
import { QrValidationError, gatewayCandidates, isLocalIpv4, validateScannedQr } from "../src/discovery/qr";

/** A fake shop gateway whose signatures come from Node's crypto, not noble. */
function makeGateway() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pub = publicKey.export({ format: "jwk" }).x as string;
  const sign = (text: string) => base64urlEncode(crypto.sign(null, Buffer.from(text), privateKey));

  function qr(over: Record<string, unknown> = {}, gatewayOver: Record<string, unknown> = {}): ShopQrPayload {
    const unsigned = {
      type: "inklink_shop",
      version: "1.0",
      shopId: "shop_001",
      gatewayId: "gateway_001",
      gateway: { discovery: "local", mdns: "gateway-001.local", ip: "192.168.1.20", port: 8000, ...gatewayOver },
      publicKey: pub,
      nonce: "nonce-123",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      ...over,
    };
    return { ...unsigned, signature: sign(canonicalJson(unsigned)) } as unknown as ShopQrPayload;
  }

  return { pub, sign, qr };
}

const expectQr = (fn: () => unknown, code: string) =>
  assert.throws(fn, (e: unknown) => e instanceof QrValidationError && e.code === code, `expected ${code}`);

describe("QR validation (gateway signs with Node crypto, app verifies with noble)", () => {
  const gw = makeGateway();

  it("accepts a correctly signed compact-JSON QR", () => {
    const q = gw.qr();
    assert.equal(validateScannedQr(JSON.stringify(q)).shopId, "shop_001");
  });

  it("accepts the Base64URL(JSON) form of the same QR", () => {
    const text = base64urlEncode(Buffer.from(JSON.stringify(gw.qr())));
    assert.equal(validateScannedQr(text).gatewayId, "gateway_001");
  });

  it("verifies regardless of the JSON key order in the QR text (canonical form)", () => {
    const q = gw.qr();
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(q).reverse()));
    assert.equal(validateScannedQr(reordered).shopId, "shop_001");
  });

  it("works with and without the optional IPv4 hint; the IP is preferred", () => {
    const withIp = validateScannedQr(JSON.stringify(gw.qr()));
    assert.deepEqual(gatewayCandidates(withIp), ["http://192.168.1.20:8000", "http://gateway-001.local:8000"]);

    const noIp = gw.qr({}, { ip: undefined });
    const parsed = validateScannedQr(JSON.stringify(noIp));
    assert.deepEqual(gatewayCandidates(parsed), ["http://gateway-001.local:8000"]);
  });

  it("accepts a signed https cloud origin and tries it after the LAN addresses", () => {
    const cloud = "https://inklink-backend-abc123.asia-south1.run.app";
    const parsed = validateScannedQr(JSON.stringify(gw.qr({}, { cloudOrigin: cloud })));
    assert.deepEqual(gatewayCandidates(parsed), ["http://192.168.1.20:8000", "http://gateway-001.local:8000", cloud]);
    // The build's fallback origin is appended once (deduplicated, trailing slash ignored).
    assert.deepEqual(gatewayCandidates(parsed, `${cloud}/`), ["http://192.168.1.20:8000", "http://gateway-001.local:8000", cloud]);
  });

  it("rejects a cloud origin that is not a plain https origin", () => {
    for (const bad of ["http://inklink.example.com", "https://inklink.example.com/path", "https://user@inklink.example.com", "javascript:alert(1)"]) {
      expectQr(() => validateScannedQr(JSON.stringify(gw.qr({}, { cloudOrigin: bad }))), "INVALID_QR");
    }
  });

  it("a changed cloud origin breaks the signature", () => {
    const q = gw.qr({}, { cloudOrigin: "https://inklink.example.com" }) as any;
    q.gateway.cloudOrigin = "https://evil.example.com";
    expectQr(() => validateScannedQr(JSON.stringify(q)), "SIGNATURE_INVALID");
  });

  it("uses the build's cloud origin as a last-resort candidate, never a non-https one", () => {
    const parsed = validateScannedQr(JSON.stringify(gw.qr()));
    assert.deepEqual(gatewayCandidates(parsed, "https://staging.inklink.example"), [
      "http://192.168.1.20:8000", "http://gateway-001.local:8000", "https://staging.inklink.example"]);
    assert.deepEqual(gatewayCandidates(parsed, "http://staging.inklink.example"), [
      "http://192.168.1.20:8000", "http://gateway-001.local:8000"]);
  });

  it("rejects an expired QR", () => {
    expectQr(() => validateScannedQr(JSON.stringify(gw.qr({ expiresAt: new Date(Date.now() - 1000).toISOString() }))), "QR_EXPIRED");
  });

  it("rejects a tampered QR (any signed field changed)", () => {
    const q = gw.qr();
    expectQr(() => validateScannedQr(JSON.stringify({ ...q, shopId: "shop_EVIL" })), "SIGNATURE_INVALID");
    expectQr(() => validateScannedQr(JSON.stringify({ ...q, gateway: { ...q.gateway, ip: "192.168.1.99" } })), "SIGNATURE_INVALID");
  });

  it("rejects a QR whose signature was made by a different key than the one it embeds", () => {
    const attacker = makeGateway();
    const q = gw.qr();
    const forged = { ...q, signature: attacker.sign(canonicalJson({ ...q, signature: undefined })) };
    expectQr(() => validateScannedQr(JSON.stringify(forged)), "SIGNATURE_INVALID");
  });

  it("rejects non-local gateway addresses so a hostile QR cannot aim uploads at the internet", () => {
    expectQr(() => validateScannedQr(JSON.stringify(gw.qr({}, { ip: "8.8.8.8" }))), "INVALID_QR");
    expectQr(() => validateScannedQr(JSON.stringify(gw.qr({}, { mdns: "evil.example.com" }))), "INVALID_QR");
    expectQr(() => validateScannedQr(JSON.stringify(gw.qr({}, { mdns: "a.local/x#" }))), "INVALID_QR");
    expectQr(() => validateScannedQr(JSON.stringify(gw.qr({}, { port: 70000 }))), "INVALID_QR");
  });

  it("rejects garbage, unsigned payloads and wrong types", () => {
    expectQr(() => validateScannedQr("hello"), "INVALID_QR");
    expectQr(() => validateScannedQr("{}"), "INVALID_QR");
    const { signature, ...unsigned } = gw.qr();
    void signature;
    expectQr(() => validateScannedQr(JSON.stringify(unsigned)), "INVALID_QR");
    expectQr(() => validateScannedQr(JSON.stringify({ ...gw.qr(), type: "other" })), "INVALID_QR");
  });

  it("classifies local IPv4 ranges", () => {
    for (const ip of ["10.0.0.5", "172.16.0.1", "172.31.255.1", "192.168.1.1", "169.254.1.1", "127.0.0.1"]) {
      assert.equal(isLocalIpv4(ip), true, ip);
    }
    for (const ip of ["8.8.8.8", "172.32.0.1", "192.169.0.1", "1.2.3", "300.1.1.1", "a.b.c.d"]) {
      assert.equal(isLocalIpv4(ip), false, ip);
    }
  });
});

describe("pairing handshake", () => {
  const gw = makeGateway();
  const qr = validateScannedQr(JSON.stringify(gw.qr()));
  const CHALLENGE = base64urlEncode(Buffer.alloc(32, 7));
  const future = () => new Date(Date.now() + 600_000).toISOString();

  const gatewayFetch =
    (respond: (challenge: string) => object, status = 200) =>
    (async (_url: string, init?: RequestInit) => {
      const { challenge } = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(respond(challenge)), { status });
    }) as unknown as typeof fetch;

  const good = (challenge: string) => ({
    signedChallenge: gw.sign(challenge),
    gatewayId: "gateway_001",
    sessionToken: "session-token-abcdefghijkl",
    sessionExpiresAt: future(),
  });

  it("accepts a gateway that proves possession of the QR's key", async () => {
    const s = await runHandshake("http://192.168.1.20:8000", qr, CHALLENGE, gatewayFetch(good));
    assert.equal(s.sessionToken, "session-token-abcdefghijkl");
  });

  it("rejects an impostor that signs with a different key", async () => {
    const impostor = makeGateway();
    await assert.rejects(
      runHandshake("http://x", qr, CHALLENGE, gatewayFetch((c) => ({ ...good(c), signedChallenge: impostor.sign(c) }))),
      (e: unknown) => e instanceof PairingError && e.code === "SIGNATURE_INVALID",
    );
  });

  it("rejects a replayed signature for a DIFFERENT challenge", async () => {
    const old = gw.sign(base64urlEncode(Buffer.alloc(32, 1)));
    await assert.rejects(
      runHandshake("http://x", qr, CHALLENGE, gatewayFetch((c) => ({ ...good(c), signedChallenge: old }))),
      (e: unknown) => e instanceof PairingError && e.code === "SIGNATURE_INVALID",
    );
  });

  it("rejects a gatewayId that differs from the QR", async () => {
    await assert.rejects(
      runHandshake("http://x", qr, CHALLENGE, gatewayFetch((c) => ({ ...good(c), gatewayId: "gateway_999" }))),
      (e: unknown) => e instanceof PairingError && e.code === "SIGNATURE_INVALID",
    );
  });

  it("rejects missing, short or already-expired sessions", async () => {
    for (const bad of [
      { sessionToken: undefined },
      { sessionToken: "short" },
      { sessionExpiresAt: new Date(Date.now() - 1000).toISOString() },
    ]) {
      await assert.rejects(
        runHandshake("http://x", qr, CHALLENGE, gatewayFetch((c) => ({ ...good(c), ...bad }))),
        (e: unknown) => e instanceof PairingError && e.code === "PAIRING_FAILED",
      );
    }
  });

  it("maps HTTP errors and network failures to distinct errors", async () => {
    await assert.rejects(
      runHandshake("http://x", qr, CHALLENGE, gatewayFetch(() => ({ success: false, error: { code: "PAIRING_FAILED", message: "nope" } }), 403)),
      (e: unknown) => e instanceof PairingError && e.code === "PAIRING_FAILED" && /nope/.test(e.message),
    );
    await assert.rejects(
      runHandshake("http://x", qr, CHALLENGE, (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch),
      (e: unknown) => e instanceof PairingError && e.code === "GATEWAY_UNREACHABLE",
    );
  });
});

describe("reconnect with a stored (pinned) shop key, no QR", () => {
  const gw = makeGateway();
  const qr = validateScannedQr(JSON.stringify(gw.qr()));
  // Exactly what the shops table keeps.
  const pinned = { publicKey: qr.publicKey, gatewayId: qr.gatewayId };
  const CHALLENGE = base64urlEncode(Buffer.alloc(32, 5));
  const reply = (sig: string, gatewayId = qr.gatewayId) =>
    (async () =>
      new Response(
        JSON.stringify({
          signedChallenge: sig,
          gatewayId,
          sessionToken: "session-token-abcdefghijkl",
          sessionExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

  it("builds candidates from stored columns, with or without an IP", () => {
    assert.deepEqual(gatewayCandidates({ gateway: { ip: "192.168.1.20", mdns: "shop.local", port: 8000 } }), [
      "http://192.168.1.20:8000",
      "http://shop.local:8000",
    ]);
    assert.deepEqual(gatewayCandidates({ gateway: { ip: null, mdns: "shop.local", port: 8000 } }), ["http://shop.local:8000"]);
  });

  it("opens a session when the gateway still holds the pinned key", async () => {
    const s = await runHandshake("http://x", pinned, CHALLENGE, reply(gw.sign(CHALLENGE)));
    assert.equal(s.sessionToken, "session-token-abcdefghijkl");
  });

  it("refuses a gateway with a different key (shop changed device or impostor)", async () => {
    const other = makeGateway();
    await assert.rejects(
      runHandshake("http://x", pinned, CHALLENGE, reply(other.sign(CHALLENGE))),
      (e: unknown) => e instanceof PairingError && e.code === "SIGNATURE_INVALID",
    );
  });
});

describe("pickReachableOrigin", () => {
  const up = (origins: string[]) =>
    (async (url: string) => {
      if (origins.some((o) => url.startsWith(o))) return new Response(null, { status: 200 });
      throw new Error("unreachable");
    }) as unknown as typeof fetch;

  it("falls back to mDNS when the IP hint is unreachable", async () => {
    assert.equal(await pickReachableOrigin(["http://ip:1", "http://m.local:1"], up(["http://m.local:1"])), "http://m.local:1");
  });
  it("prefers the IPv4 hint when both answer", async () => {
    assert.equal(await pickReachableOrigin(["http://ip:1", "http://m.local:1"], up(["http://ip:1", "http://m.local:1"])), "http://ip:1");
  });
  it("returns null when nothing answers, and does not hang on a slow host", async () => {
    const slow = (async () => new Promise(() => {})) as unknown as typeof fetch;
    assert.equal(await pickReachableOrigin(["http://a:1"], slow, 50), null);
  });
});

describe("published interop vectors verify with noble too", () => {
  // Same constants as docs/API_CONTRACTS.md and the agent's vectors.test.ts.
  const pub = "ebVWLo_mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ";
  const qrCanonical =
    '{"expiresAt":"2030-01-01T00:00:00.000Z","gateway":{"discovery":"local","ip":"192.168.1.20","mdns":"gateway-001.local","port":8000},"gatewayId":"gateway_001","nonce":"AAECAwQFBgcICQoL","publicKey":"ebVWLo_mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ","shopId":"shop_001","type":"inklink_shop","version":"1.0"}';

  it("accepts the documented QR signature and rejects it for any other bytes", () => {
    const sig = "w2YMAQjC9utmmpS7z_Tnxm9HxrYdDkDyQrunujR761f79w2TrD7cXidRUDPPozmGAUh7PSJfND1io_8_n6McAQ";
    assert.equal(verifySignature(qrCanonical, sig, pub), true);
    assert.equal(verifySignature(qrCanonical.replace("shop_001", "shop_002"), sig, pub), false);
  });

  it("accepts the documented pairing-challenge signature", () => {
    const challenge = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
    const sig = "lz3N-oxfN0f_KDlpeh0UvEhCzn_iG0Aznh-wEUfZq-9Y_Pp5BecE3Ay-BIkuJiF0KV1Y7WZA-F-tsysP5VYZAQ";
    assert.equal(verifySignature(challenge, sig, pub), true);
  });

  it("signs the documented authorization with the byte-identical signature", () => {
    const seed = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);
    const req = buildSignedAuthorization(
      seed,
      {
        agentId: "inklink_payment_agent", merchantId: "shop_001", maxPerTransaction: "1.00",
        totalSpendingLimit: "5.00", asset: "USDC", expiresAt: "2030-01-01T00:00:00.000Z",
      },
      Uint8Array.from({ length: 16 }, (_, i) => i),
    );
    assert.equal(req.devicePublicKey, "uvxxvq06xeS2PpyCFu5xo0quxlci7tvKcotOmzzM45Y");
    assert.equal(req.customerReference, "dev_uvxxvq06xeS2PpyCFu5xo0");
    assert.equal(req.signature, "AzKuH4zCyXc5tHL6wxwIpOArKNRVSu-4jPObogtWM_ZRVdPxAtmPCj8YFQQLhCzHxV2uvYhPHqHr-cRa6IbrCA");
  });
});

describe("Ed25519 interop (noble in the app <-> Node crypto)", () => {
  const seed = Buffer.alloc(32, 9);
  const nodeKey = crypto.createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
    format: "der",
    type: "pkcs8",
  });
  const secret = Uint8Array.from(seed);

  it("derives the same public key and the identical (deterministic) signature", () => {
    const nodePub = crypto.createPublicKey(nodeKey).export({ format: "jwk" }).x as string;
    assert.equal(publicKeyFor(secret), nodePub);

    const msg = '{"hello":"inklink"}';
    const nodeSig = base64urlEncode(crypto.sign(null, Buffer.from(msg), nodeKey));
    assert.equal(signMessage(msg, secret), nodeSig);
    assert.equal(verifySignature(msg, nodeSig, nodePub), true);
  });

  it("builds a payment authorization whose bytes Node's verifier accepts, and a tamper is caught", () => {
    const nonce = Uint8Array.from({ length: 16 }, (_, i) => i);
    const req = buildSignedAuthorization(
      secret,
      {
        agentId: "inklink_payment_agent", merchantId: "shop_001",
        maxPerTransaction: "1.00", totalSpendingLimit: "5.00", asset: "USDC",
        expiresAt: "2030-01-01T00:00:00.000Z",
      },
      nonce,
    );
    assert.match(req.customerReference, /^dev_/);
    assert.equal(req.devicePublicKey, publicKeyFor(secret));
    assert.equal(req.nonce, base64urlEncode(nonce));

    const { signature, ...unsigned } = req;
    const signed = canonicalJson({ type: "inklink_payment_authorization", version: "1.0", ...unsigned });
    const nodePub = crypto.createPublicKey(nodeKey);
    assert.equal(crypto.verify(null, Buffer.from(signed), nodePub, Buffer.from(signature, "base64url")), true);

    const tampered = canonicalJson({ type: "inklink_payment_authorization", version: "1.0", ...unsigned, totalSpendingLimit: "500.00" });
    assert.equal(crypto.verify(null, Buffer.from(tampered), nodePub, Buffer.from(signature, "base64url")), false);
  });

  it("formats a short, comparable key fingerprint", () => {
    assert.match(publicKeyFingerprint(publicKeyFor(secret)), /^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);
  });
});
