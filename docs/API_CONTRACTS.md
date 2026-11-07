# Inklink — API Contracts (v0.1, locked decisions applied)

Source of truth in code: `packages/shared-schemas`. The main backend owner (XYZ) owns final
schema approval; any breaking change is communicated before implementation. Do not change
endpoint names, payment states, network or asset independently.

## Architecture

```
App ──(session token)──▶ Inklink backend ──(bearer)──▶ Payment Agent ──▶ x402 gate ──▶ Hedera
                              ▲                              │
                              └──── signed settlement callback (HMAC) ───┘
```

- The **app talks only to the Inklink backend / shop gateway**. It never calls the payment agent
  or the gate, and never sends or computes a USDC amount.
- The **backend** owns the quote, INR→USDC conversion, authorization validation and the
  authoritative job/payment status.
- The **payment agent** (Omkar) and **x402 gate** (Omkar, Node) are internal services.

## Conventions

- Base URL: `http://<gateway-local-ip>:8000/api/v1` (local) / `https://<cloud-run-url>/api/v1` (cloud).
  The local address comes from the signed QR; it is never hardcoded.
- JSON everywhere except document upload (`multipart/form-data`). Money is a **decimal string**.
- After pairing every request carries `Authorization: Bearer <sessionToken>`. Exempt:
  `GET /health`, `POST /pairing/verify`, and `/internal/*` (which use their own auth).
- Errors use one envelope and the HTTP status must match:

```json
{ "success": false, "error": { "code": "SHOP_UNAVAILABLE", "message": "..." } }
```

### ErrorCode (final list)

`SHOP_UNAVAILABLE` `SHOP_NOT_FOUND` `GATEWAY_UNREACHABLE` `INVALID_QR` `QR_EXPIRED`
`SIGNATURE_INVALID` `PAIRING_FAILED` `DOCUMENT_TOO_LARGE` `UNSUPPORTED_FORMAT` `UPLOAD_FAILED`
`JOB_NOT_FOUND` `QUOTE_EXPIRED` `UNAUTHORIZED` `SESSION_EXPIRED` `AUTHORIZATION_INVALID`
`AUTHORIZATION_SIGNATURE_INVALID` `AUTHORIZATION_REPLAYED` `RESOURCE_NOT_ALLOWED`
`FACILITATOR_UNAVAILABLE` `POLICY_VIOLATION` `PAYMENT_FAILED` `SETTLEMENT_UNVERIFIED`
`FACILITATOR_UNSUPPORTED` `INTERNAL_ERROR`

Suggested HTTP mapping: 400 invalid input · 401 `UNAUTHORIZED`/`SESSION_EXPIRED` · 403
`AUTHORIZATION_SIGNATURE_INVALID`/`POLICY_VIOLATION`/`RESOURCE_NOT_ALLOWED` · 404 not found ·
409 `AUTHORIZATION_REPLAYED` · 410 `QUOTE_EXPIRED` · 413 `DOCUMENT_TOO_LARGE` ·
415 `UNSUPPORTED_FORMAT` · 422 `SETTLEMENT_UNVERIFIED` · 503 `FACILITATOR_UNAVAILABLE`.

### Statuses (confirmed)

- Job: `created` `awaiting_payment` `awaiting_execution` `executing` `completed` `cancelled` `failed`
- Device: `unknown` `offline` `ready` `processing` `paper_unavailable` `jam` `error`
- Payment: `created` `pending` `awaiting_authorization` `processing` `settled` `failed` `expired` `refunded`
- Settlement moves the job to **`awaiting_execution`**, never to `completed`.

## Shared wire format (signing)

All signatures are **Ed25519**. Keys (raw 32 bytes) and signatures (64 bytes) are **Base64URL,
unpadded** (padding is tolerated on decode). Signed bytes are the UTF-8 of a **canonical JSON**
string: keys sorted recursively, no whitespace, absent optional fields omitted (not `null`).

```python
# canonical JSON (Python)
json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
# Base64URL
base64.urlsafe_b64encode(raw).rstrip(b"=").decode()
```

### Interop test vectors (pinned by automated tests on both sides)

Gateway key seed `0102…1f20` (hex) → public key `ebVWLo_mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ`.

QR canonical string (what is signed; note `signature` is excluded):

```
{"expiresAt":"2030-01-01T00:00:00.000Z","gateway":{"discovery":"local","ip":"192.168.1.20","mdns":"gateway-001.local","port":8000},"gatewayId":"gateway_001","nonce":"AAECAwQFBgcICQoL","publicKey":"ebVWLo_mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ","shopId":"shop_001","type":"inklink_shop","version":"1.0"}
```
QR signature: `w2YMAQjC9utmmpS7z_Tnxm9HxrYdDkDyQrunujR761f79w2TrD7cXidRUDPPozmGAUh7PSJfND1io_8_n6McAQ`

Pairing: challenge `AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8` (signed as the literal string) →
`lz3N-oxfN0f_KDlpeh0UvEhCzn_iG0Aznh-wEUfZq-9Y_Pp5BecE3Ay-BIkuJiF0KV1Y7WZA-F-tsysP5VYZAQ`

Callback HMAC: secret `test-secret-0123456789abcdef`, timestamp `1700000000`, raw body
`{"paymentId":"payment_1","jobId":"job_1","amount":"0.10"}` →
`sha256=47e949af76798bac7c53f33164612740179350ac8897c06c18e4142d8526d43c`

Authorization: device seed `fffe…e0e1e0` → public key `uvxxvq06xeS2PpyCFu5xo0quxlci7tvKcotOmzzM45Y`,
`customerReference` `dev_uvxxvq06xeS2PpyCFu5xo0`, canonical string:

```
{"agentId":"inklink_payment_agent","asset":"USDC","customerReference":"dev_uvxxvq06xeS2PpyCFu5xo0","devicePublicKey":"uvxxvq06xeS2PpyCFu5xo0quxlci7tvKcotOmzzM45Y","expiresAt":"2030-01-01T00:00:00.000Z","maxPerTransaction":"1.00","merchantId":"shop_001","nonce":"AAECAwQFBgcICQoLDA0ODw","totalSpendingLimit":"5.00","type":"inklink_payment_authorization","version":"1.0"}
```
signature: `AzKuH4zCyXc5tHL6wxwIpOArKNRVSu-4jPObogtWM_ZRVdPxAtmPCj8YFQQLhCzHxV2uvYhPHqHr-cRa6IbrCA`

## Discovery and pairing

### Signed QR payload

QR text = compact JSON of the object below, or the Base64URL of that JSON. The app accepts both.

```json
{
  "type": "inklink_shop", "version": "1.0",
  "shopId": "shop_001", "gatewayId": "gateway_001",
  "gateway": { "discovery": "local", "mdns": "gateway-001.local", "ip": "192.168.1.20", "port": 8000 },
  "publicKey": "<b64url>", "nonce": "<unique>", "expiresAt": "ISO-8601",
  "signature": "<b64url Ed25519 over canonical JSON without `signature`>"
}
```

- `ip` is optional (IPv4). The app probes `ip` and `mdns` in parallel and prefers the IP.
- The app **rejects** gateways that are not on the local network: `mdns` must end in `.local`
  and `ip` must be private/link-local. A hostile QR cannot aim uploads at the internet.
- The app rejects expired, unsigned, tampered or wrong-key QRs, and pins the QR's public key.

### `POST /api/v1/pairing/verify` (no session required)

Request `{ "challenge": "<b64url, 16-256 chars>" }`. The gateway signs the **literal challenge
string** (UTF-8) and issues a session:

```json
{ "signedChallenge": "<b64url>", "gatewayId": "gateway_001",
  "sessionToken": "<opaque, >=16 chars>", "sessionExpiresAt": "ISO-8601" }
```

`signedChallenge`/`gatewayId` are agreed, and so are `sessionToken`/`sessionExpiresAt`: the backend
(`services/backend/app/routes_native.py`) returns exactly these fields. The app trusts nothing until the signature
verifies against the QR's key and `gatewayId` matches. On a 401 the app silently re-runs this
handshake once and retries.

## Contracts

Flow: `POST /jobs` → `POST /documents` → `POST /jobs/{id}/quote` → `POST /payments/authorizations`
→ `POST /payments` → poll `GET /payments/{id}` and `GET /jobs/{id}/status`.

| # | Endpoint | Notes |
|---|----------|-------|
| 1 | `GET /shops/{shopId}` | |
| 3 | `POST /jobs` | Call first; the backend mints the authoritative `jobId` |
| 2 | `POST /documents` (multipart: `file`, `shopId`, `customerId`, `jobId`) | Max 25 MB, PDF/DOCX. Honors `Idempotency-Key` |
| 4 | `POST /jobs/{jobId}/quote` | INR quote **plus `settlement`** (below) |
| 5 | `POST /payments/authorizations` | Device-signed (below) |
| 6 | `POST /payments` | App sends only `{jobId, quoteId, authorizationId, paymentMethod}` |
| 7 | `GET /payments/{paymentId}` | `settled` only from a verified callback; `transactionId` only once settled |
| 8 | `GET /jobs/{jobId}/status` | Backend-authoritative |

`customerId` on upload is the anonymous `customerReference` (no PII).

### Contract 3 — print configuration

```json
{ "shopId": "shop_001",
  "printConfig": { "copies": 1, "pageRange": "all", "colourMode": "grayscale",
                   "paperSize": "A4", "orientation": "portrait", "sides": "one-sided" } }
```

- `paperSize`: `A4 | Letter | Legal` (A3 removed: the printer agent does not support it).
- `orientation`: `portrait | landscape`; `sides`: `one-sided | two-sided-long-edge |
  two-sided-short-edge`. Same values as the printer agent (`OPERATOR_*`). Optional in the type for
  older clients; the app always sends them.
- `colourMode` stays `grayscale | colour`; the backend maps it to the printer's
  `monochrome | color`. The printer path supports `pageRange: "all"` only for now.

### Contract 4 — quote with settlement

```json
{ "quoteId": "quote_001", "jobId": "job_001", "merchantId": "shop_001",
  "amount": "20.00", "asset": "INR", "expiresAt": "ISO-8601",
  "paymentMethods": ["traditional", "hedera_x402"],
  "settlement": { "asset": "HTS-USDC", "amount": "0.10", "rate": "0.005", "capturedAt": "ISO-8601" } }
```

Backend policy (agreed): rate snapshot valid 5 minutes, USDC to 6 decimals, **round up**, FX
provider configurable, **quote expiry is the payment deadline**. The app only displays this.
`rate` is USDC per 1 INR (confirmed by the backend owner; the deployed rate is 0.012, so 2.00 INR
quotes as 0.024 USDC).

### Contract 5 — device-signed authorization

```json
{ "customerReference": "dev_…", "agentId": "inklink_payment_agent", "merchantId": "shop_001",
  "maxPerTransaction": "1.00", "totalSpendingLimit": "5.00", "asset": "USDC",
  "expiresAt": "ISO-8601", "nonce": "<b64url, >=16 bytes>",
  "devicePublicKey": "<b64url>", "signature": "<b64url>" }
```

`nonce`, `devicePublicKey` and `signature` are additions to the earlier shape. The signature
covers the fields above plus `type`/`version` (see vector). The payment agent verifies: field
formats, key/signature lengths, `customerReference == "dev_" + first 22 chars of devicePublicKey`,
agent id, expiry in the future and ≤ 24 h, then the signature. A nonce is single-use; the exact
same signed request is idempotent. The private key never leaves the phone.

## Internal: backend → payment agent

All require `Authorization: Bearer <INTERNAL_API_TOKEN>`.

- `POST /api/v1/payments/authorizations` — forward the app's Contract 5 body unchanged.
- `POST /api/v1/payments`:

```json
{ "jobId": "job_001", "quoteId": "quote_001", "authorizationId": "auth_001",
  "paymentMethod": "hedera_x402", "merchantId": "shop_001",
  "settlementAmount": "0.10",
  "resourceUrl": "http://<gate>/api/v1/jobs/job_001/execute",
  "quoteExpiresAt": "ISO-8601" }
```

`quoteExpiresAt` is the authoritative backend quote expiry and is **required**: the agent rejects a request without a valid timestamp and refuses to start a payment after it. `MERCHANT_ACCOUNT_ID` must differ from `HEDERA_AGENT_ACCOUNT_ID`; the agent refuses to run otherwise.
The agent only pays gates whose **origin is allowlisted** and whose path is exactly
`/api/v1/jobs/{jobId}/execute` for the same job.

**Endpoint discovery and price reading.** With `X402_GATE_ORIGIN` set, the agent finds the paid
endpoint itself:
1. It reads the gate's `GET /discovery/resources`. This is the x402 Bazaar `DiscoveryResourcesResponse`,
   with the official Bazaar extension and the tag `print-job`.
2. It builds the job's URL from the listed route template.

`resourceUrl` is then **optional**. If it's sent and differs from the discovered URL, the request
is refused.

Before signing, the agent always sends one unpaid request and reads the job's price from the
`402` `PAYMENT-REQUIRED` header. If the amount, pay-to account or asset differs from the
authorized payment, it fails with `gate_price_mismatch`, and nothing is signed.

- `GET /api/v1/payments/{paymentId}` — agent-side status. The backend may use this to learn
  about **failures**; it must learn about **success** only from the signed callback.
- `GET /health` — unauthenticated; `{ ok, facilitator: "ok"|"unavailable" }`.

## Internal: x402 gate

`POST /api/v1/jobs/{jobId}/execute` — HTTP 402 with the exact USDC amount and the shop's Hedera
account as `payTo`, asset USDC `0.0.429274`, network `hedera:testnet`, then Blocky402
verify/settle. A successful payment only means payment was accepted; it never implies the printer
finished. Prices come from the backend via a lookup, see below.

**Agreed and implemented by the backend:** `GET /api/v1/internal/jobs/{jobId}/payment-requirements`
(`Authorization: Bearer <BACKEND_API_TOKEN>`) →
`{ "jobId", "merchantAccountId": "0.0.X", "amount": "0.10", "expiresAt": "ISO-8601" }`.
The URL is configuration on the gate (`REQUIREMENTS_URL_TEMPLATE`), so the real name can differ.

## Internal: agent → backend settlement callback

`POST /api/v1/internal/payment-settled`, sent only after the agent verified the transfer on the
Hedera mirror node. Retried with exponential backoff (1s, 2s, 4s … capped at 30s, ±20% jitter,
up to 8 attempts); `paymentId` is the idempotency key.

```json
{ "paymentId": "payment_001", "jobId": "job_001", "payerAccount": "0.0.X",
  "merchantAccountId": "0.0.X", "network": "hedera:testnet", "asset": "HTS_USDC",
  "amount": "0.10", "transactionId": "0.0.123@1700000000.000000001",
  "settlementTimestamp": "ISO-8601", "status": "settled",
  "hashscanUrl": "https://hashscan.io/testnet/transaction/0.0.123-1700000000-000000001" }
```

Headers: `X-Inklink-Timestamp: <unix seconds>`, `X-Inklink-Signature: sha256=<hex>`,
`Idempotency-Key: <paymentId>`. Signature = `HMAC-SHA256(secret, timestamp + "." + rawBody)`.
Verify over the **raw request bytes** (never re-serialize JSON) and reject timestamps older
than 5 minutes. Retry-safe responses: 2xx (also for duplicates); the agent retries 5xx/408/429
and stops on any other 4xx.

The backend should also check the event against what it expects (jobId, `amount` equals the
quoted settlement amount, `merchantAccountId`, `hashscanUrl` derived from `transactionId`) and
treat a second settlement for the same `paymentId` with a different `transactionId` as an error.

## Naming note (please confirm)

The settlement asset is written three ways, as in the agreed contracts: `USDC` (Contracts 5-7 and
the policy), `HTS-USDC` (quote `settlement.asset`), `HTS_USDC` (callback/registry). They are
implemented exactly as written; unifying them later would be a contract change.

## OfflinePay (signed offline authorization) — BUILT

Status: core implemented and tested (`packages/shared-schemas/src/offline-pay.ts`, app signer
`apps/mobile/src/crypto/offline-pay.ts`) and the agent settle endpoint (below) are built and
tested. The backend endpoint `POST /api/v1/offline-payments` is built and tested (`services/backend/app/offline_pay.py`, below); it has not run against the live payment agent yet.
The app's "Pay later (OfflinePay)" screen (`apps/mobile/app/offline-pay.tsx`) signs the voucher
with the device key, checks the phone's own limits first, sends it to that endpoint and follows
`GET /api/v1/offline-payments/{voucherId}` until it is `SETTLED` with a verified transaction.
The phone records a voucher only once the backend has it (or may have it, after a network
failure; the identical voucher is then resent), and frees its own limit only on that verified
settlement.

An offline voucher is the customer's device-signed promise to pay one job's backend-quoted USDC
amount when the shop has no internet. It is **not a payment**. It becomes `SETTLED` only after the
normal Hedera x402 settlement for that job is verified on the mirror node.

```text
AUTHORIZED_OFFLINE -> PENDING_SETTLEMENT -> SETTLED
                           |      ^
                           v      | retry
                     SETTLEMENT_FAILED
```

Voucher (all fields signed except `signature`):

```json
{ "type": "inklink_offline_payment", "version": "1.0",
  "voucherId": "<16 random bytes, Base64URL>", "jobId": "...", "quoteId": "...",
  "merchantId": "shop_001", "amount": "0.10", "asset": "USDC",
  "devicePublicKey": "<Ed25519, Base64URL>", "customerReference": "dev_<first 22 of key>",
  "issuedAt": "ISO-8601", "expiresAt": "ISO-8601", "signature": "<Base64URL>" }
```

Signed bytes: UTF-8 of `canonicalJson(voucher without signature)` (same rules as every other
Inklink signature; Python: `json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`).
Unknown fields are rejected.

Shop-side checks, in order: structure, signature, `customerReference` belongs to the key, amount
positive and at most `maxPerVoucher`, `merchantId` is this shop, `expiresAt - issuedAt` at most
`maxValidityMs`, `issuedAt` not in the future beyond `clockSkewMs`, not expired. Then the ledger:
identical voucher again is idempotent, same `voucherId` with other content is `REPLAYED`, a second
voucher for the same job is `DUPLICATE_JOB`, and the device's unsettled total may not exceed
`maxOutstanding` (failed settlements still count; the shop is unpaid). The device runs the same
ledger before signing, so it cannot exceed its limit across shops.

Default policy (agreed): `maxPerVoucher` 2.00 USDC, `maxOutstanding` 5.00 USDC, validity 2 h,
clock skew 5 min. The app signs vouchers valid for 30 min.

Reconciliation accepts `SETTLED` only with `transactionVerified: true`, a `verifiedAt`, a Hedera
transaction id (`0.0.x@seconds.nanos`), the same `jobId`, the same `paymentId` if one was recorded
and exactly the voucher amount. Anything else is refused and the voucher stays pending. The same
settlement again is idempotent; a different transaction for a settled voucher is refused. The
ledger is persisted before each change and refuses to load a corrupt file.

Test vector (device seed = 32 bytes of `0x09`, voucherId bytes = 16 bytes of `0x01`, issued
`2026-11-06T10:00:00.000Z`, job `job_vector`, quote `quote_vector`, `shop_001`, `0.10`). Verified in
TypeScript (noble and node:crypto) and Python (`cryptography`):

```text
signed text: {"amount":"0.10","asset":"USDC","customerReference":"dev__RckOFqgx1tk-3jNYC-h2Z","devicePublicKey":"_RckOFqgx1tk-3jNYC-h2ZH96_drE8WO1wLqyDXp9hg","expiresAt":"2026-11-06T10:30:00.000Z","issuedAt":"2026-11-06T10:00:00.000Z","jobId":"job_vector","merchantId":"shop_001","quoteId":"quote_vector","type":"inklink_offline_payment","version":"1.0","voucherId":"AQEBAQEBAQEBAQEBAQEBAQ"}
signature:   cUvdzz9y-8K1IT0U4b89ZzSvasw9bLeTjooCpszEbDF6I3x6yHJI9J7-CP5FgsFpUQ1kE1moD6xG8qV0iDl-AQ
```

### Backend endpoint: `POST /api/v1/offline-payments` (built)

Paired-app session (`Authorization: Bearer <native session>`). Body `{ "voucher": { ...signed voucher... } }`.
Response `200`: `{ voucher (no signature), state, acceptedAt, updatedAt, settlementAttempts, paymentId?, failureReason?,
duplicate, settlement, jobId }`. `settlement` is `started` | `retry_later` | `refused` | `in_progress` | `not_payable`.

The backend, in this order:

1. Finds the job (404 unless this app created or claimed it) and its **current** quote: `voucher.quoteId` must be that quote
   and `voucher.amount` must equal the quote's USDC settlement amount **exactly as a string** (else 400 `AMOUNT_INVALID`). The
   quote must be unexpired (410 `QUOTE_EXPIRED`), the job `awaiting_payment` with no payment in progress (409).
2. If the session proved a device key when pairing, the voucher must be signed by that key (403 `SIGNATURE_INVALID`).
   This is checked before anything is recorded.
3. Runs the ledger rules above (merchant = the job's shop). Errors: `400 INVALID_VOUCHER | AMOUNT_INVALID | EXPIRED |
   NOT_YET_VALID | VALIDITY_TOO_LONG`, `403 SIGNATURE_INVALID | WRONG_MERCHANT | OVER_VOUCHER_LIMIT | OVER_OUTSTANDING_LIMIT`,
   `409 REPLAYED | DUPLICATE_JOB`. The signed promise counts as the customer's approval of the quote.
4. Calls the agent's `settle` with a new `paymentId` = `offpay_` + 24 hex, `settlementAmount` = the quote amount and
   `resourceUrl` = `<GATE_URL>/api/v1/jobs/{jobId}/execute`. The job goes to payment `processing` and stays `awaiting_payment`.
   Agent unreachable or 5xx: the voucher stays `AUTHORIZED_OFFLINE` and a background task retries every 30 s. A definitive
   refusal (4xx) is recorded and not retried. `VOUCHER_SETTLEMENT_IN_PROGRESS` leaves the voucher `PENDING_SETTLEMENT`.
5. The voucher becomes `SETTLED` **only** from the HMAC-verified settlement callback (verified Hedera tx id, same job, exact
   amount). A payment that fails or expires moves it to `SETTLEMENT_FAILED`; the retry task then uses a **new** `paymentId`
   (3 attempts). Failed vouchers still count toward the device's unsettled limit.

`GET /api/v1/offline-payments/{voucherId}` returns the backend's ledger record (404 `UNKNOWN_VOUCHER`). The job view carries
it as `offlinePayment`. The ledger is persisted in `state.json` with the rest of the backend state.

### Agent endpoint: `POST /api/v1/offline-payments/settle` (agreed, built)

Internal, `Authorization: Bearer <INTERNAL_API_TOKEN>` (plus the Cloud Run ID token in
`X-Serverless-Authorization`). Called by the backend once internet returns, after it has accepted and
recorded the voucher itself.

```json
{ "paymentId": "<backend-assigned, [A-Za-z0-9_-]{1,64}>", "jobId": "...", "quoteId": "...",
  "merchantId": "shop_001", "settlementAmount": "0.10",
  "resourceUrl": "<gate>/api/v1/jobs/{jobId}/execute", "voucher": { ... signed voucher ... } }
```

Response `200 { "paymentId", "voucherId", "status", "voucherState" }`; then poll
`GET /api/v1/payments/{paymentId}` as for online payments. `GET /api/v1/offline-payments/{voucherId}`
returns the agent's ledger record.

The agent checks again because it is the only party that can spend:

- the voucher's signature and fields, as of just before its expiry. It can be settled up to 7 days
  after `expiresAt`; older is `410 VOUCHER_TOO_OLD`.
- the voucher must match the request exactly (job, quote, merchant, amount). If not, it's
  `422 VOUCHER_MISMATCH`, and nothing is recorded.
- its own per-device ledger: replay (`409 REPLAYED`), one voucher per job (`409 DUPLICATE_JOB`) and
  the unsettled limit (`403 OVER_OUTSTANDING_LIMIT`).

Then it pays through the same gate, with the same exact-match x402 signing and mirror-node
verification. It sends the **same signed settlement callback**, carrying the backend's `paymentId`,
and writes the same HCS audit entry.

Retries and double-pay protection:

- **Same request again:** idempotent, with no second payment.
- **Nothing was submitted** (facilitator refused, or gate or merchant not allowed): the voucher is
  `SETTLEMENT_FAILED`. Retry it with a **new** `paymentId`; the same one is `409 PAYMENT_ID_CONFLICT`.
- **Funds may have moved** (a transaction was claimed but is unverified, a signed transfer was
  sent but no settlement answer came back, or a restart interrupted it): the voucher **stays
  `PENDING_SETTLEMENT`** while the agent resolves it. For the "no settlement answer, no tx id"
  case the agent searches the mirror node for the exact agent→merchant transfer made after it
  signed, and either settles the payment (so the voucher reconciles to `SETTLED`) or, once the
  transaction's validity window has fully passed with no such transfer, releases the spend and
  fails it. Until then, any retry is
  `409 VOUCHER_SETTLEMENT_IN_PROGRESS`. Only re-verification on the mirror node resolves it, at
  startup or when the payment is re-checked.
- **Persistence:** the ledger file (`OFFLINE_LEDGER_FILE`, default next to `AGENT_STATE_FILE`) is
  saved before each change, and the agent refuses to start if it's corrupt.