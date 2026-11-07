# Inklink — Integration Status

Honest implementation status. Mocks and planned features are labelled. Nothing fakes a
blockchain settlement (dev rule 8).

## Locked decisions (team lead, round 2)

| Area | Decision | In code |
|------|----------|---------|
| Who calls what | App talks **only** to the Inklink backend; backend → payment agent → Hedera x402 | Done: app has no agent client; agent is internal |
| Agent inputs | Backend calls `POST /api/v1/payments` with `merchantId`, `settlementAmount` (USDC), `resourceUrl` (+ ids) | Done (`quoteExpiresAt` added, see below) |
| Internal auth | Shared bearer token from env, no unauthenticated internal calls | Done; server refuses to start without it |
| Quote | Contract 4 carries `settlement {asset: HTS-USDC, amount, rate, capturedAt}`; backend computes, app only displays | Done in types, app UI, mock |
| FX policy | 5 min snapshot, 6 dp, round **up**, quote expiry = payment deadline, provider configurable | Mock follows it; real FX is the backend's |
| Merchant endpoint | Node x402 gate behind the backend; **not** hand-rolled in FastAPI | Done (`npm run gate`) |
| Paid route | `POST /api/v1/jobs/{jobId}/execute`, exact USDC, shop `payTo`; payment ≠ job completed | Done |
| Merchant account | XYZ provides it, funded, associated with USDC | Done: shop wallet `0.0.11227614`, USDC associated, receives the payments |
| Facilitator | Blocky402 only, **no fallback** | Done; `FACILITATOR_UNAVAILABLE` on outage |
| Callback | `POST /api/v1/internal/payment-settled`, HMAC over raw body with `X-Inklink-Timestamp`/`-Signature`, 5-min window, retries with backoff, `paymentId` idempotency | Done on the agent; receiver reference in mock |
| Status enums | As listed in API_CONTRACTS.md; settlement → `awaiting_execution` | Done |
| Polling | REST, 2.5 s | Done |
| QR | Ed25519, Base64URL, canonical JSON without `signature`, fields incl. optional IPv4 | Done: real verifier, no dev mock |
| IPv4 hint | Optional; prefer it when mDNS fails | Done (parallel probe, IP preferred) |
| Pairing | `POST /pairing/verify {challenge}` → `{signedChallenge, gatewayId}` + session token | Done in app + mock; **session field names proposed** |
| Transport | Local HTTP in **dev builds only**; production TLS + pinning | Dev cleartext via `app.config.js`; **TLS/pinning not built** |
| BLE | Not required for the demo | Not implemented |
| `/health` | Unauthenticated, nothing sensitive | Done |
| Identity | Anonymous per-install id | Derived from the device key |
| Authorization | **Device-key Ed25519 signature**, explicit approval | Done end to end; verified by the agent |
| Uploads | `Idempotency-Key` honored by the gateway | App sends it; mock honors it |
| HCS | The backend publishes job-lifecycle events to its own topic. Separately, the payment agent writes a spend-audit entry per verified payment to its own topic `0.0.11339168` (submit key = agent key, no admin key) | Agent audit log done and live; the backend's lifecycle topic is the backend's |
| Registry fields | Incl. `payerAccount`, real `transactionId`, derived HashScan URL | In the callback event |
| Repo | https://github.com/Danish26-dev/InkLink-ethglobal_mumbai | Pushed; both developers commit directly to `main` |
| Handles | XYZ will send; I won't invent placeholders | README keeps `_TBD_` |

## Module status

| Module | Status |
|--------|--------|
| `packages/shared-schemas` | Contracts, wire format (canonical JSON, Base64URL), authorization, callback headers/event. ESM (`"type":"module"`). |
| `services/payment-agent` | Bearer auth, device-signature verification, backend-supplied intent, resource allowlist, exact-match x402 policy, mirror-node verification, spend reservation, HMAC callback with retries, x402 gate, durable state file with restart recovery (re-verifies claimed transactions, never releases spend when the outcome is unknown, resends undelivered callbacks). HCS spend audit log (agent-signed topic, no admin key). OfflinePay settle endpoint, x402 endpoint discovery with a 402 price check before signing, fail-fast secret config, no over-limit or double payment under concurrency, spend kept once a transfer is signed, and a payment whose settlement response was lost is resolved by a mirror-node search. **120 tests pass.** Deployed on Cloud Run (the lost-response resolver is committed but not yet in the deployed image). |
| `apps/mobile` | Expo SDK 58. Camera QR scan, real Ed25519 verification, challenge-response pairing, session auth with re-handshake, reconnect to paired shops by pinned key, upload progress with idempotent retry, device key in secure storage, signed authorization, quote with USDC settlement + deadline, 12 screens, OfflinePay vouchers, device-proof pairing (stable `native_dev_` identity), print options, OfflinePay "Pay later" screen. **87 tests pass**; typecheck clean; Android and web bundles compile. **Confirmed on a physical Android phone** (staging APK against the Cloud Run backend): an x402 payment, tx `0.0.7162784@1794008216.704679762`, and an OfflinePay promise settled on Hedera, tx `0.0.7162784@1794008511.539597966`. |
| `services/mock-gateway` | Mock backend: signed QR, pairing, sessions, FX (mock rate, rounds up), agent calls, callback receiver, gate requirements endpoint. **11 tests pass.** |

## Verified on Hedera testnet (real settlement)

**Current state.** Real USDC settlements on Hedera testnet have run in three ways, all
`SUCCESS` on the mirror node, each with a matching entry in the agent's HCS audit topic
`0.0.11339168`. The full list with HashScan links is in the "Proof" table of the root `README.md`
(Hedera section):

- **From a physical phone, through the deployed cloud stack:** x402 and OfflinePay, one each.
- **Through the deployed cloud stack, driven by the app's own API client:** several payments and a
  voucher, including the resend-is-idempotent check.
- **`npm run demo:pay`** against a stand-in shop account, including the refusal case
  (`-- --negative`), where the agent refuses to sign and nothing moves.

What is **not** verified live: a page physically printing (the shop gateway and printer are not
connected yet), and 0G on-chain records (the contract is not deployed). Neither affects the Hedera
payments.

### First run (history)

The first real settlement, kept as a record of how it was done. One real x402 payment was run with
`npm run demo:pay` (2026-11-05):

- Transaction: `0.0.7162784@1793916490.190691897`
  (https://hashscan.io/testnet/transaction/0.0.7162784@1793916490.190691897)
- Mirror node: `SUCCESS`, consensus `2026-11-05T22:08:17Z`.
- Transfer: 0.10 USDC (`0.0.429274`) from the agent `0.0.11330279` to the merchant `0.0.11227614`,
  settled by Blocky402 on `hedera:testnet` after the agent checked the device-signed spend limits.

What this run was and was not:

- It used the in-process gate with a FIXED dev price (0.10), a dev device key, and a **stand-in
  merchant account** that Omkar controls. It did not go through the phone app or the real Inklink
  backend.
- The settlement callback returned HTTP 401 because a leftover test server with a different secret
  was listening on :8000, not a real backend. The payment itself is confirmed by the mirror node.
- It still has to be repeated with the real merchant account and the real backend.
## Verified end to end (no funded wallet)

Headless run of the app's real client code against mock backend + agent + gate, plus the live
Blocky402 facilitator (24 checks, `npm run headless` in `apps/mobile`):

- Signed-QR verification, IPv4 reachability, handshake, session; calls before pairing and with a
  forged token are refused.
- Upload, quote with backend-computed USDC, tampered authorization refused, signed one accepted.
- Payment path: backend → agent → gate (price fetched from the backend) → agent signs → facilitator
  rejects the throwaway key with `invalid_exact_hedera_payload_signature_invalid`; the backend learns
  of the failure; the job is **not** authorized.
- Callback receiver: wrong secret, altered body, wrong amount, wrong merchant, bad HashScan URL,
  different tx id → rejected; valid → accepted; duplicate → idempotent; job → `awaiting_execution`.
- Python 3.14 reproduces the canonical JSON, Base64URL and HMAC vectors and verifies the Ed25519 QR
  and challenge signatures.

## NOT done

Done since the first version of this file (so they are no longer gaps): a funded settlement through
the real backend and the real shop account (phone and cloud); the backend's OfflinePay endpoint
(`POST /api/v1/offline-payments`, `services/backend/app/offline_pay.py`) and the agent's settle
endpoint, proven live; the real backend and gateway integration, deployed on Cloud Run.

Still not done:

- Gateway TLS + certificate/public-key pinning (production). The staging app already reaches the
  cloud backend over HTTPS; plain HTTP is only used for the local-network dev path.
- BLE discovery (QR + local Wi-Fi only, per team decision).
- The shop printer is not connected yet, so a paid job waits at `awaiting_execution` until the shop
  gateway runs (backend's side). 0G on-chain records need the 0G contract deployed (backend's side).
- Request timeouts on the payment path, and re-sending a failed callback without a restart.
- On-device SLM and document editing were dropped from the app (team decision): users pick copies,
  colour, paper size, orientation and sides directly. The backend prices and prints the whole
  document, so the app has no page-range option.

## Frozen contracts (team lead, round 3) — historical

> **Historical.** This was the contract freeze before the first integration. The contracts were
> reviewed and merged, and both developers now commit directly to `main`. Statuses in the table
> below are as they were at the freeze; the current state is in the sections above.

Frozen for review: nothing merged to `main` until the contracts and integration tests were reviewed
together. The commits were kept on `feat/native-app-hedera-x402` meanwhile.

| # | Decision | Status |
|---|----------|--------|
| 1 | Dedicated testnet merchant account with HTS-USDC `0.0.429274` associated; **agent wallet and merchant wallet are separate accounts** | Account ID pending (XYZ, shared privately). The agent now refuses to start when both IDs are equal |
| 2 | Pairing response: `signedChallenge`, `gatewayId`, `sessionToken`, `sessionExpiresAt`. Token is short-lived and bound to the verified gateway | Fields frozen. Lifetime and gateway binding are the backend's to enforce (mock: 15 min) |
| 3 | `GET /api/v1/internal/jobs/{jobId}/payment-requirements`; the backend owns the quote and settlement amount, the agent never converts INR to USDC | Frozen. Agent only reads the amount |
| 4 | FX: USDC per 1 INR, 5 min snapshot, 6 dp, round up, backend quote expiry is the deadline | Frozen. Display-only in the app |
| 5 | Callback HMAC-SHA256 over `timestamp + "." + rawBody`; headers `X-Inklink-Timestamp` / `X-Inklink-Signature`; reject expired timestamps and duplicates | Agent signs; mock receiver is the reference (5-min window, `paymentId` idempotency) |
| 6 | Contract 5 adds `nonce`, `devicePublicKey`, `signature`; backend validates and enforces policy | Frozen |
| 7 | Backend to agent: `jobId, quoteId, authorizationId, paymentMethod, merchantId, settlementAmount, resourceUrl, quoteExpiresAt` with `INTERNAL_API_TOKEN` | Frozen. `quoteExpiresAt` is now **required** (agent rejects a request without a valid one) |
| 8 | Agent verifies settlement on the mirror node and signs the callback; backend moves the job to `awaiting_execution`; settlement never marks a print `completed` | Done |
| 9 | HCS published by the backend only, one shared topic | Backend's |
| 10 | Blocky402, no fallback facilitator or network | Done |
| 11 | Local HTTP for the controlled dev demo; production needs TLS and pinning | TLS and pinning not built |
| 12 | Branch stays `feat/native-app-hedera-x402`, no merge to `main` yet | Respected |

## Still open

1. How the backend refreshes the QR on expiry and revokes session tokens (the QR is valid for 1
   hour and a session for 15 minutes).
2. Production TLS and certificate or public-key pinning.
3. The shop gateway and printer going live, and the 0G contract deployment (backend's side).

(Closed since the freeze: the merchant account ID, and integration against the actual Inklink
backend. The mock gateway remains the executable reference and the offline dev stack.)
## Setting up your own funded wallet

To reproduce a real settlement yourself (these steps were completed for the live deployment):

1. Create a dedicated ECDSA testnet account at https://portal.hedera.com/ and claim test HBAR.
2. Fill `services/payment-agent/.env` (never commit it).
3. `npm run setup:wallet -- --associate`, mint test USDC at https://faucet.circle.com/.
4. Point `MERCHANT_ACCOUNT_ID` at a USDC-associated shop account (`npm run setup:merchant` makes a
   stand-in), run `npm run setup:wallet` until ready, then `npm run demo:pay`.
