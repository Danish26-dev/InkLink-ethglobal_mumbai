# Inklink — Integration Guide (for the backend / gateway owner)

What the real backend and gateway must do to plug into the app and the payment services. The
`services/mock-gateway` implements every item below and is the executable reference. Exact
shapes: `API_CONTRACTS.md`. Verified in Python 3.14 (stdlib + the `cryptography` package) against the
pinned vectors: canonical JSON, Base64URL, the callback HMAC, and Ed25519 verification of the QR
and challenge signatures. The key-generation and signing lines in snippet 1 use the standard
`cryptography` API but were not themselves run; check your output against the vectors.

## 1. Gateway: sign the shop QR and answer the handshake

Generate an Ed25519 keypair once. Publish the raw 32-byte public key as Base64URL.

```python
import base64, json, os
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

def b64u(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()

def canonical(obj) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)

key = Ed25519PrivateKey.generate()
unsigned = {
    "type": "inklink_shop", "version": "1.0", "shopId": "shop_001", "gatewayId": "gateway_001",
    "gateway": {"discovery": "local", "mdns": "gateway-001.local", "ip": "192.168.1.20", "port": 8000},
    "publicKey": b64u(key.public_key().public_bytes_raw()),
    "nonce": b64u(os.urandom(12)), "expiresAt": "2030-01-01T00:00:00.000Z",
}
qr = {**unsigned, "signature": b64u(key.sign(canonical(unsigned).encode()))}
qr_text = json.dumps(qr, separators=(",", ":"))      # render this as the QR code
```

- Omit `ip` entirely if unknown (never `null`). Use a private LAN address, not a public one.
- The app rejects `mdns` values not ending in `.local` and non-private IPs.
- Handshake `POST /api/v1/pairing/verify {challenge}`: sign the **literal challenge string**:
  `b64u(key.sign(challenge.encode()))`, return it with `gatewayId`, plus a random short-lived
  `sessionToken` and `sessionExpiresAt`. Reject challenges that are not Base64URL, 16-256 chars.
- Require `Authorization: Bearer <sessionToken>` on every other `/api/v1` route except `/internal/*`,
  returning `401 UNAUTHORIZED` or `401 SESSION_EXPIRED`. `GET /health` stays open and non-sensitive.
- Verify the QR/vectors with `API_CONTRACTS.md` before wiring it to the app.

## 2. Quote: compute the USDC amount

On `POST /jobs/{jobId}/quote` return the INR quote **and** `settlement`
(`{asset:"HTS-USDC", amount, rate, capturedAt}`). Use integer/decimal arithmetic (never float),
USDC to 6 decimals, **round up**, snapshot valid 5 minutes, quote expiry = payment deadline. Keep the
FX provider configurable. Store the amount: it is what the agent will pay and what the gate will
demand, and what the callback must match.

## 3. Payment: call the payment agent

On `POST /payments`, validate the quote exists, belongs to the job and has not expired, then call
the agent (bearer `INTERNAL_API_TOKEN`) with:
`jobId, quoteId, authorizationId, paymentMethod, merchantId, settlementAmount, resourceUrl,
quoteExpiresAt`. `resourceUrl` is `<gate-origin>/api/v1/jobs/{jobId}/execute`. Forward the app's
Contract 5 body to `POST /api/v1/payments/authorizations` unchanged (the agent verifies the device
signature). Do not mark a payment `settled` because the agent says so on a status poll; use polling
only to learn about failures.

## 4. The x402 gate asks you what a job must pay (agreed; implemented by the backend)

`GET /api/v1/internal/jobs/{jobId}/payment-requirements` with `Authorization: Bearer
<BACKEND_API_TOKEN>` →
`{"jobId","merchantAccountId":"0.0.X","amount":"0.10","expiresAt":"ISO-8601"}`.
`amount` must be exactly the stored settlement amount; `merchantAccountId` is the shop's Hedera
account, **associated with USDC `0.0.429274`**. Name and path are configuration on the gate
(`REQUIREMENTS_URL_TEMPLATE`). `services/backend` serves this endpoint at the path above and the
deployed gate uses it.

## 5. Receive the settlement callback

`POST /api/v1/internal/payment-settled`. Verify over the **raw bytes**:

```python
import hashlib, hmac, time

def verify_callback(raw: bytes, ts: str, sig: str, secret: str) -> bool:
    if not ts.isdigit() or abs(time.time() - int(ts)) > 300:
        return False
    mac = "sha256=" + hmac.new(secret.encode(), ts.encode() + b"." + raw, hashlib.sha256).hexdigest()
    return hmac.compare_digest(mac, sig)
# FastAPI: raw = await request.body()  — parse JSON from `raw`, do not re-serialize it.
```

Then validate the event against what you stored: `jobId`, `amount == settlement amount`,
`merchantAccountId`, `status == "settled"`, `network == "hedera:testnet"`, `asset == "HTS_USDC"`,
and `hashscanUrl` derived from `transactionId` (`@`→`-`, last `.`→`-`). Be **idempotent on
`paymentId`**: a duplicate with the same `transactionId` returns 2xx and changes nothing (no second
settlement record, no second printer trigger); a different `transactionId` for a settled payment is an
error. On success set payment `settled` and the job `awaiting_execution` (never `completed`). The
agent retries 5xx/408/429 with backoff and stops on other 4xx, so return 2xx for duplicates.

Publish `{paymentId, jobId, payerAccount, merchantAccountId, network, asset, amount,
transactionId, settlementTimestamp, status, hashscanUrl}` to HCS and the 0G registry from this event.
Never fabricate a transaction id or URL.

## 6. Running it all locally (reference stack)

```
mock-gateway :8000   payment-agent :4021 (internal)   x402 gate :4022 (internal)
```

See `ENVIRONMENT.md` for the variables and `TESTING.md` for the headless end-to-end run, which
exercises pairing, signed authorization, the payment path and every callback rejection case.

## 7. Open items

See `INTEGRATION_STATUS.md`.
