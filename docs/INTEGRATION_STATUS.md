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
| Merchant account | XYZ provides it, funded, associated with USDC | **Pending (XYZ)** |
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
| HCS | Backend publishes from the signed callback; one shared topic, I create none | Nothing to build here |
| Registry fields | Incl. `payerAccount`, real `transactionId`, derived HashScan URL | In the callback event |
| Repo | https://github.com/Danish26-dev/InkLink-ethglobal_mumbai | **Not pushed yet** |
| Handles | XYZ will send; I won't invent placeholders | README keeps `_TBD_` |

## Module status

| Module | Status |
|--------|--------|
| `packages/shared-schemas` | Contracts, wire format (canonical JSON, Base64URL), authorization, callback headers/event. ESM (`"type":"module"`). |
| `services/payment-agent` | Bearer auth, device-signature verification, backend-supplied intent, resource allowlist, exact-match x402 policy, mirror-node verification, spend reservation, HMAC callback with retries, x402 gate, durable state file with restart recovery (re-verifies claimed transactions, never releases spend when the outcome is unknown, resends undelivered callbacks). **78 tests pass.** |
| `apps/mobile` | Expo SDK 58. Camera QR scan, real Ed25519 verification, challenge-response pairing, session auth with re-handshake, reconnect to paired shops by pinned key, upload progress with idempotent retry, device key in secure storage, signed authorization, quote with USDC settlement + deadline, 12 screens. **39 tests pass**; typecheck clean; Android and web bundles compile. **Not confirmed on a physical phone.** |
| `services/mock-gateway` | Mock backend: signed QR, pairing, sessions, FX (mock rate, rounds up), agent calls, callback receiver, gate requirements endpoint. **11 tests pass.** |

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

- **A real funded settlement** — no transaction id, no HashScan proof yet.
- Gateway TLS + certificate/public-key pinning (production).
- BLE. OfflinePay. On-device SLM (labelled mock). HCS publishing (backend's).
- The real backend/gateway integration (waiting on XYZ's implementation).

## Frozen contracts (team lead, round 3)

Frozen for review: nothing merges to `main` until the contracts and integration tests are reviewed
together. All 13+ commits stay on `feat/native-app-hedera-x402`.

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

1. **Merchant account ID** from XYZ (private channel), then a coordinated funded settlement test.
2. Integration against the **actual Inklink backend**; the mock gateway is a reference, not the final target.
3. How the backend refreshes the QR on expiry and revokes session tokens.
4. Production TLS and certificate or public-key pinning.
## Action items for Omkar (blocks the first real settlement)

1. Create a dedicated ECDSA testnet account at https://portal.hedera.com/ and claim test HBAR.
2. Fill `services/payment-agent/.env` (never commit it).
3. `npm run setup:wallet -- --associate`, mint test USDC at https://faucet.circle.com/.
4. Get the merchant account from XYZ; `npm run setup:wallet` until ready, then `npm run demo:pay`.
