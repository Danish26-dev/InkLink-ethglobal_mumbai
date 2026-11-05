import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  base64urlDecode,
  base64urlEncode,
  canonicalJson,
  customerReferenceFor,
} from "@inklink/shared-schemas";
import { verifyEd25519 } from "../src/device-auth.js";

const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));

describe("base64url", () => {
  it("matches Node's base64url for every length 0..40", () => {
    for (let n = 0; n <= 40; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 255);
      const expected = Buffer.from(bytes).toString("base64url");
      assert.equal(base64urlEncode(bytes), expected, `length ${n}`);
      assert.deepEqual(Array.from(base64urlDecode(expected)), Array.from(bytes), `length ${n}`);
    }
  });

  it("tolerates trailing '=' padding (Python's urlsafe_b64encode) on decode", () => {
    assert.deepEqual(Array.from(base64urlDecode("YQ==")), [97]);
    assert.deepEqual(Array.from(base64urlDecode("YWI=")), [97, 98]);
  });

  it("rejects standard-base64 characters and impossible lengths", () => {
    assert.throws(() => base64urlDecode("a+b/"));
    assert.throws(() => base64urlDecode("A"));
    assert.throws(() => base64urlDecode("ab!d"));
  });
});

describe("canonicalJson", () => {
  it("sorts keys recursively with no whitespace", () => {
    assert.equal(canonicalJson({ b: 1, a: "x", c: { z: true, y: null } }), '{"a":"x","b":1,"c":{"y":null,"z":true}}');
  });

  it("omits undefined properties (e.g. an absent optional ip)", () => {
    assert.equal(canonicalJson({ port: 8000, ip: undefined, mdns: "g.local" }), '{"mdns":"g.local","port":8000}');
  });

  it("keeps array order and rejects non-finite numbers", () => {
    assert.equal(canonicalJson({ a: [3, 1, { b: 2, a: 1 }] }), '{"a":[3,1,{"a":1,"b":2}]}');
    assert.throws(() => canonicalJson({ n: NaN }));
  });

  it("equals Python's json.dumps(sort_keys=True, separators=(',',':'), ensure_ascii=False)", () => {
    // Expected string produced by that Python call for this object.
    assert.equal(
      canonicalJson({ type: "inklink_shop", gateway: { port: 8000, mdns: "gateway-001.local" }, version: "1.0" }),
      '{"gateway":{"mdns":"gateway-001.local","port":8000},"type":"inklink_shop","version":"1.0"}',
    );
  });
});

describe("Ed25519 verification (RFC 8032 test vector 1)", () => {
  const pub = hex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
  const sig = hex(
    "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
  );

  it("accepts the standard signature over the empty message", () => {
    assert.equal(verifyEd25519(new Uint8Array(0), sig, pub), true);
  });

  it("rejects a different message or a flipped signature bit", () => {
    assert.equal(verifyEd25519(Uint8Array.from([1]), sig, pub), false);
    const bad = Uint8Array.from(sig);
    bad[10] ^= 1;
    assert.equal(verifyEd25519(new Uint8Array(0), bad, pub), false);
  });

  it("rejects malformed keys instead of throwing", () => {
    assert.equal(verifyEd25519(new Uint8Array(0), sig, new Uint8Array(5)), false);
  });
});

describe("customerReference", () => {
  it("is derived from the device key and carries no personal data", () => {
    assert.equal(customerReferenceFor("AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"), "dev_AbCdEfGhIjKlMnOpQrStUv");
  });
});
