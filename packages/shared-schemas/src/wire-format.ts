/**
 * Wire format helpers shared by every signer/verifier in Inklink.
 *
 * Everything that is signed (QR payloads, pairing challenges, payment
 * authorizations) uses the SAME two primitives so independent implementations
 * (TypeScript app, Node agent, Python gateway) agree byte for byte:
 *
 *   1. canonicalJson   — deterministic JSON text (the bytes that get signed)
 *   2. Base64URL       — unpadded URL-safe base64 for keys, signatures, nonces
 *
 * Python equivalent of canonicalJson for the Inklink value types (strings,
 * integers, booleans, nested objects, arrays):
 *
 *   json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
 *
 * Python equivalent of Base64URL (unpadded):
 *
 *   base64.urlsafe_b64encode(raw).rstrip(b"=").decode()
 */

/**
 * Deterministic JSON: object keys sorted, no whitespace, `undefined` properties
 * omitted. Throws on values that have no stable JSON form (NaN, Infinity,
 * bigint, functions) rather than silently signing something ambiguous.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error("canonicalJson: non-finite number");
      }
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
      }
      const obj = value as Record<string, unknown>;
      const parts = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
      return `{${parts.join(",")}}`;
    }
    default:
      throw new Error(`canonicalJson: unsupported type ${typeof value}`);
  }
}

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const LOOKUP: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET[i]] = i;

/** Unpadded Base64URL. No Buffer/btoa so it behaves identically in RN and Node. */
export function base64urlEncode(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out +=
      ALPHABET[(n >> 18) & 63] +
      ALPHABET[(n >> 12) & 63] +
      ALPHABET[(n >> 6) & 63] +
      ALPHABET[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63];
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out +=
      ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63];
  }
  return out;
}

/**
 * Strict Base64URL decode. Trailing `=` padding is tolerated (Python's
 * urlsafe_b64encode emits it) but any character outside the URL-safe alphabet is
 * rejected, including standard-base64 `+` and `/`.
 */
export function base64urlDecode(text: string): Uint8Array {
  const s = text.replace(/=+$/, "");
  if (s.length % 4 === 1) throw new Error("base64url: invalid length");
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const chunk = s.slice(i, i + 4);
    let n = 0;
    for (const ch of chunk) {
      const v = LOOKUP[ch];
      if (v === undefined) throw new Error("base64url: invalid character");
      n = (n << 6) | v;
    }
    const bits = chunk.length * 6;
    n <<= 24 - bits;
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length && chunk.length > 2) out[o++] = (n >> 8) & 255;
    if (o < out.length && chunk.length > 3) out[o++] = n & 255;
  }
  return out;
}

const textEncoder = new TextEncoder();

/** UTF-8 bytes of a string (what Ed25519 signs/verifies). */
export function utf8(text: string): Uint8Array {
  return textEncoder.encode(text);
}

/**
 * Anonymous per-install customer reference, derived from the device public key.
 * Because the payment authorization is signed by that same key, a caller cannot
 * claim someone else's reference. Contains no personal information.
 */
export function customerReferenceFor(devicePublicKeyB64u: string): string {
  return `dev_${devicePublicKeyB64u.slice(0, 22)}`;
}
