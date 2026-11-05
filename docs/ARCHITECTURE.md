# Inklink — Architecture (native app + Hedera x402)

Covers the native app, the payment agent, the x402 gate and the mock backend, and how they sit in
the wider Inklink system. Exact request/response shapes: `API_CONTRACTS.md`. Security properties:
`SECURITY.md`. Payment sequence: `PAYMENT_FLOW.md`.

## Principle

Basic printing works over the local network without the Inklink cloud, 0G, a blockchain or remote
AI. Hedera payments and AI are optional layers on top.

## System

```
                 QR + local Wi-Fi                        internal (bearer token)
 Phone app ───────────────────────▶ Inklink backend ───────────────────────▶ Payment Agent
 (React Native)   session token     / shop gateway   ◀── signed callback ──   (Node, signs on Hedera)
                                   (XYZ; mock-gateway                              │
                                    stands in for dev)                             ▼
                                                                              x402 gate ──▶ Blocky402 ──▶ Hedera Testnet
```

- The **app talks only to the backend / shop gateway**. It never calls the payment agent or the gate
  and never sends or computes a USDC amount.
- The **backend** owns the quote, INR→USDC conversion, session auth and the authoritative job and
  payment status. Payment becomes `settled` only on a verified, signed callback.
- The **payment agent** verifies the customer's device-signed spending policy, enforces it, signs the
  Hedera transfer, verifies settlement on-chain and sends the callback.
- The **x402 gate** is an isolated Node service behind the backend that issues the HTTP 402 for
  `POST /api/v1/jobs/{jobId}/execute` and settles through the Blocky402 facilitator.

## Native app (`apps/mobile`)

- **Screens** (`app/`, Expo Router): welcome, discovery, scan, connection, document, configure,
  preview, payment, authorize, payment-status, tracking, history, settings.
- **State** (`src/state/app-context.tsx`): API client, connection manager, pairing, working job session.
- **API client** (`src/api/client.ts`): Contracts 1-8 through one base URL, session bearer token,
  automatic re-handshake on a 401.
- **Discovery** (`src/discovery/`): signed-QR parsing and Ed25519 verification (`qr.ts`), address
  probing and the challenge-response handshake (`pairing.ts`).
- **Crypto** (`src/crypto/`): Ed25519 sign/verify, the device key in secure storage, and the signed
  payment authorization. Pure modules are testable under Node.
- **Connection** (`src/connection/`): four independent states (shop identified, gateway reachable,
  internet, cloud).
- **Storage** (`src/db/`): SQLite for paired shops (pinned public key) and job history. No private
  keys, no documents.
- **Assistant** (`src/assistant/`): Local Assistant interface with a clearly labelled mock.

## Payment agent (`services/payment-agent`)

| Module | Responsibility |
|--------|----------------|
| `server.ts`, `auth.ts` | Internal HTTP API; bearer auth on everything except `/health` |
| `device-auth.ts` | Verifies the Ed25519 device signature on a spending policy |
| `policy.ts`, `money.ts` | Allowlist, per-tx and total limits, asset, expiry; exact decimal math |
| `payment-agent.ts`, `store.ts` | Orchestration, spend reservation, idempotency, resource allowlist |
| `signing/signing-service.ts` | The only module that loads the Hedera key; exact-match x402 policy |
| `x402-client.ts` | Pays an x402 resource using the official `@x402` packages |
| `settlement.ts` | Mirror-node verification; HMAC-signed callback with retries |
| `x402-gate.ts`, `gate-requirements.ts`, `gate-server.ts` | The gate and where it learns each job's price |
| `facilitator.ts` | Confirms Blocky402 supports Hedera testnet (no fallback) |
| `scripts/` | `setup-wallet`, `demo-pay`, `check-facilitator`, dev device |

## Shared package (`packages/shared-schemas`)

TypeScript contracts for the app, agent and mock backend, plus the signing wire format (canonical
JSON, Base64URL) so every implementation produces identical bytes. Consumed from its compiled `dist/`.

## Mock backend (`services/mock-gateway`)

A development stand-in for the real backend and shop gateway, and the executable reference for how
the real one should behave: signed QR, pairing and sessions, a mock FX rate (rounded up), calling the
agent, and verifying the settlement callback idempotently. The device progression after payment is a
mock timer standing in for the ESP32.

## Trust boundaries

- The agent's Hedera key never leaves the signing service; the customer's device key never leaves the
  phone; neither is ever visible to an LLM.
- The agent pays only allowlisted gate origins, for the exact backend-decided amount.
- The agent never authorizes a job; the backend does, after validating the callback.
- The 0G execution registry and HCS audit trail are owned by the backend; the payment side only
  supplies the verified settlement details.

## Status

See `INTEGRATION_STATUS.md` for what is verified and what is not (notably: no real funded settlement
yet, and the app is not yet confirmed on a physical phone).
