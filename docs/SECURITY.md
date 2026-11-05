# Inklink — Security (Native App + Payment)

Covers Omkar's modules. Project-wide principles apply (team brief §11).

## Keys

| Key | Where it lives | Never |
|-----|----------------|-------|
| Agent Hedera wallet key | Payment agent signing service only (`.env`, gitignored) | in the app, in an LLM, logs, API responses, git |
| Customer device key (Ed25519) | Phone secure store (Keychain / Keystore), this-device-only | leaves the device; only signatures do |
| Gateway Ed25519 key | The shop gateway | in the app (the app holds only its public key) |
| Shared secrets (`INTERNAL_API_TOKEN`, `PAYMENT_EVENT_SIGNING_SECRET`, `BACKEND_API_TOKEN`) | Environment variables | defaults: the services refuse to start without them (min 16 chars) |

A dedicated Hedera testnet account is used, never a personal or mainnet wallet. On web (dev
preview only) the device key falls back to `localStorage`, which is **not** secure.

## Customer authorization (cryptographically backed)

The customer reviews and explicitly approves a spending policy. The app signs it with the device
key over canonical JSON (policy, merchant, per-tx max, total limit, asset, nonce, expiry). The
agent verifies the signature, that `customerReference` is derived from the signing key, an expiry
within 24 h, and consumes the nonce (replay protection). A tampered limit, a different key, a
different agent id, an expired or over-long policy, and a reused nonce are all rejected. This
replaces the earlier "dedicated agent wallet + JSON policy" model. The agent wallet remains the
autonomous payer, bounded by this signed policy.

## Payment safety

- The backend decides the USDC amount. The agent refuses any x402 option not exactly equal to
  `{merchant payTo, USDC 0.0.429274, hedera:testnet, settlementAmount}` **before signing**.
- Authorization policy enforced before signing: allowlist, per-tx max, total limit, asset, expiry.
- Spend is reserved atomically with the check (no concurrent over-spend).
- The agent only pays **allowlisted gate origins** at the job's own execute path; no credentials in
  URLs; http(s) only.
- Quote expiry is the payment deadline.
- `settled` requires mirror-node confirmation of the exact transfer; unconfirmed claims keep the
  spend reserved and are never exposed as evidence.
- No automatic facilitator/network/asset fallback.

## Service-to-service

- Payment agent: every route except `/health` needs `Authorization: Bearer <INTERNAL_API_TOKEN>`
  (constant-time compare). `/health` returns no sensitive data.
- Settlement callback: HMAC-SHA256 over `timestamp + "." + rawBody`, headers
  `X-Inklink-Timestamp` / `X-Inklink-Signature`, 5-minute freshness, `Idempotency-Key = paymentId`.
  The timestamp is inside the MAC so a captured request cannot be replayed with a fresh one.
  Retried with exponential backoff; duplicates must be idempotent on the backend.

## Discovery trust

- QR payloads are Ed25519-signed by the gateway. The app verifies structure, expiry and signature,
  and **rejects non-local addresses** (`.local` names, private/link-local IPv4 only).
- Reachability is not trust: after probing, the gateway must sign a fresh random challenge with the
  QR's key and match the QR's `gatewayId` before a session token is accepted. A replayed signature
  for another challenge is rejected.
- All later local calls (uploads included) carry a short-lived Bearer session; on 401 the app
  re-runs the handshake against the pinned key.

## Transport

Development builds allow plain HTTP to local addresses only (`usesCleartextTraffic` on Android,
`NSAllowsLocalNetworking` on iOS). **Expo Go success is not production readiness.** Production must
use gateway TLS with certificate/public-key pinning (build with `INKLINK_ENV=production`, which
turns cleartext off). Documents must never go over an untrusted network without an authenticated
pairing session.

## Data minimisation

- Documents stay on the shop gateway; never in the cloud unnecessarily, never on-chain.
- Customer id is anonymous and derived from the device key. No personal information is required.
- Callbacks, HCS and 0G records carry no document contents, names, PII, URLs or secrets.
- No third-party trackers or analytics in the app.

## Known limits (honest)

- Agent state (authorizations, nonces, payments, pending callbacks) is a single JSON file written
  atomically after every change (`AGENT_STATE_FILE`). It survives restarts, and on startup the agent
  re-verifies payments that were mid-flight, re-sends undelivered callbacks, and marks payments whose
  outcome cannot be known as failed **with the spend kept**. It is not a database: one process only,
  no encryption at rest (it holds no keys), and it needs backups for anything beyond a demo.
- A corrupt state file stops the agent from starting; it is never silently replaced, because an empty
  state would reset every spending limit.
- BLE discovery is not implemented (QR + local Wi-Fi only, per team decision).
- Local HTTP is unencrypted in development builds; see Transport.
- Mock gateway FX and device progression are mocks.
