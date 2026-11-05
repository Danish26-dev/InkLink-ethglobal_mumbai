/**
 * Verifies the payment agent's signed settlement callback.
 *
 * This is the reference for what the real backend (FastAPI) must do. Python:
 *
 *   ts  = request.headers["X-Inklink-Timestamp"]
 *   sig = request.headers["X-Inklink-Signature"]          # "sha256=<hex>"
 *   raw = await request.body()                             # the RAW bytes, not re-serialized JSON
 *   if abs(time.time() - int(ts)) > 300: reject
 *   mac = "sha256=" + hmac.new(secret, ts.encode() + b"." + raw, hashlib.sha256).hexdigest()
 *   if not hmac.compare_digest(mac, sig): reject
 */

import crypto from "node:crypto";
import {
  CALLBACK_MAX_AGE_SECONDS,
  INKLINK_SIGNATURE_HEADER,
  INKLINK_TIMESTAMP_HEADER,
} from "@inklink/shared-schemas";

export type CallbackAuthResult =
  | { ok: true }
  | { ok: false; reason: "MISSING_HEADERS" | "STALE_TIMESTAMP" | "BAD_SIGNATURE" };

export function verifyCallback(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  secret: string,
  nowMs: number = Date.now(),
): CallbackAuthResult {
  const get = (name: string) => {
    const v = headers[name.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  };
  const timestamp = get(INKLINK_TIMESTAMP_HEADER);
  const signature = get(INKLINK_SIGNATURE_HEADER);
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) {
    return { ok: false, reason: "MISSING_HEADERS" };
  }

  if (Math.abs(nowMs / 1000 - Number(timestamp)) > CALLBACK_MAX_AGE_SECONDS) {
    return { ok: false, reason: "STALE_TIMESTAMP" };
  }

  const expected =
    "sha256=" +
    crypto
      .createHmac("sha256", secret)
      .update(Buffer.concat([Buffer.from(`${timestamp}.`), rawBody]))
      .digest("hex");

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b)
    ? { ok: true }
    : { ok: false, reason: "BAD_SIGNATURE" };
}
