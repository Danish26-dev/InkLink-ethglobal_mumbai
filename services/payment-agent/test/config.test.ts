/**
 * Fail-fast configuration: the HTTP service must refuse to start on missing or weak secrets
 * (a 2-character INTERNAL_API_TOKEN once reached Secret Manager), and the paying and
 * receiving wallets must be different accounts.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertWalletsSeparate, loadServerSecurityConfig } from "../src/config.js";

const KEYS = ["INTERNAL_API_TOKEN", "PAYMENT_EVENT_SIGNING_SECRET", "ALLOWED_RESOURCE_ORIGINS"] as const;
const STRONG = "a".repeat(64);

describe("loadServerSecurityConfig", () => {
  // dotenv may have loaded a local .env; isolate each test and restore afterwards.
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    process.env.INTERNAL_API_TOKEN = STRONG;
    process.env.PAYMENT_EVENT_SIGNING_SECRET = STRONG;
    delete process.env.ALLOWED_RESOURCE_ORIGINS;
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("loads strong secrets and defaults the gate allowlist to the local gate", () => {
    const cfg = loadServerSecurityConfig();
    assert.equal(cfg.internalApiToken, STRONG);
    assert.equal(cfg.callbackSigningSecret, STRONG);
    assert.deepEqual(cfg.allowedResourceOrigins, ["http://localhost:4022"]);
  });

  it("refuses to start without a bearer token or callback secret", () => {
    for (const k of ["INTERNAL_API_TOKEN", "PAYMENT_EVENT_SIGNING_SECRET"] as const) {
      const keep = process.env[k];
      delete process.env[k];
      assert.throws(() => loadServerSecurityConfig(), new RegExp(`Missing required env var ${k}`));
      process.env[k] = "   ";
      assert.throws(() => loadServerSecurityConfig(), new RegExp(`Missing required env var ${k}`));
      process.env[k] = keep;
    }
  });

  it("refuses short (guessable) secrets, ignoring surrounding whitespace", () => {
    process.env.INTERNAL_API_TOKEN = "ab";
    assert.throws(() => loadServerSecurityConfig(), /INTERNAL_API_TOKEN must be at least 16 characters/);
    process.env.INTERNAL_API_TOKEN = `  ${"x".repeat(15)}  `;
    assert.throws(() => loadServerSecurityConfig(), /at least 16/);
    process.env.INTERNAL_API_TOKEN = STRONG;
    process.env.PAYMENT_EVENT_SIGNING_SECRET = "short";
    assert.throws(() => loadServerSecurityConfig(), /PAYMENT_EVENT_SIGNING_SECRET must be at least 16/);
  });

  it("parses a comma-separated gate allowlist and drops empty entries", () => {
    process.env.ALLOWED_RESOURCE_ORIGINS = " https://gate.example , ,http://localhost:4022,";
    assert.deepEqual(loadServerSecurityConfig().allowedResourceOrigins, [
      "https://gate.example",
      "http://localhost:4022",
    ]);
  });
});

describe("assertWalletsSeparate", () => {
  it("accepts different agent and merchant accounts", () => {
    assert.doesNotThrow(() => assertWalletsSeparate("0.0.11330279", "0.0.11227614"));
  });

  it("refuses paying yourself, even with stray whitespace", () => {
    assert.throws(() => assertWalletsSeparate("0.0.11330279", " 0.0.11330279 "), /must differ/);
  });
});
