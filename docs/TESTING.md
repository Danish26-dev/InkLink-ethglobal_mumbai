# Inklink — Testing (Omkar's modules)

Each module is testable on its own, with no hardware and no funded wallet.

## Unit and interop tests

```bash
cd services/payment-agent && npm test      # 106 tests
cd apps/mobile            && npm test      # 74 tests
cd services/mock-gateway  && npm test      # 11 tests
```

Typecheck everything:

```bash
cd packages/shared-schemas && npm run typecheck
cd services/payment-agent  && npm run typecheck
cd services/mock-gateway   && npm run typecheck
cd apps/mobile             && npm run typecheck     # app + tests/scripts
```

What the tests pin down:

- **Money:** decimal strings only, exact integer math, USDC rounding up.
- **Policy and agent:** per-tx/total limits, merchant allowlist, device-signature verification
  (tamper, wrong key, wrong agent, expiry, replay, idempotency), resource-URL allowlist, quote
  deadline, spend reservation under concurrency, release on facilitator rejection, spend kept when
  settlement cannot be confirmed, no tx id exposed unless settled.
- **Settlement:** mirror-node matching of token, merchant and exact amount; the callback's fields,
  derived HashScan URL, raw-body HMAC, timestamp window, retry/backoff behaviour.
- **Wire format:** Base64URL against Node's, canonical JSON, RFC 8032 Ed25519 vector.
- **Interop:** the app's `@noble` Ed25519 produces byte-identical signatures to Node's crypto; the
  agent's real verifier accepts what the app builds; the mock receiver accepts what the agent sends.
- **Published vectors** (`docs/API_CONTRACTS.md`): QR, pairing challenge, callback HMAC and
  authorization signatures are pinned on both sides.
- **Discovery:** valid/expired/tampered/wrong-key/non-local QRs, handshake impostors and replays,
  IPv4-vs-mDNS probing.
- **Device-proof pairing:** the device key signs only an app-generated 32-byte challenge; a fake
  gateway mirroring `services/backend/app/routes_native.py` verifies it and derives the stable
  `native_dev_` identity; forged proofs, identity changes and gateways without proof support.
- **OfflinePay:** voucher signature (noble signs, Node verifies), limits, expiry, replay, duplicates,
  persistence, and the agent settle endpoint's states (no retry once funds may have moved).
- **x402 endpoint discovery:** the gate's Bazaar discovery document, the agent picking the endpoint
  itself and refusing a 402 price that differs from the quote (`gate_price_mismatch`).
- **HCS spend audit:** entry contents, retry of unpublished entries on recovery.
- **Configuration:** the service refuses to start on missing or short (<16 chars) secrets; gate
  allowlist parsing; agent and merchant wallets must differ.

Not covered by automated tests: the Express route wiring in `services/payment-agent/src/server.ts`
(the logic behind each route is tested directly).

## Headless end-to-end (real client code, mock backend)

Start the three services (see `ENVIRONMENT.md` for the shared secrets), then:

```bash
cd services/mock-gateway  && npm start        # :8000, prints a QR
cd services/payment-agent && npm run gate     # :4022, with REQUIREMENTS_URL_TEMPLATE set
cd services/payment-agent && npm start        # :4021
cd apps/mobile && PAYMENT_EVENT_SIGNING_SECRET=… MERCHANT_ACCOUNT_ID=… npm run headless
```

24 checks across pairing, signed authorization, the payment path and the callback receiver (forged,
tampered, wrong amount, duplicate). Without a funded wallet the payment ends `failed` at the
facilitator by design; the callback cases use synthetic, shared-secret-signed events and are clearly
**not** real payments. The mock gateway has no device-proof support, so the headless flow pairs
without it (the device-proof path is covered by `apps/mobile/test/pairing-device.test.ts`).

## Real settlement (needs a funded wallet)

```bash
cd services/payment-agent
npm run setup:wallet                 # balances + token association for agent and merchant
npm run setup:wallet -- --associate  # associate USDC to the agent
npm run demo:pay                     # device-signed authorization -> pay -> settle -> verify -> HashScan link
npm run demo:pay -- --negative       # overpay attempt: refused, nothing signed
```

`demo:pay` only reports success if the mirror node shows the USDC transfer to the merchant. Real
testnet settlements have been run this way; the transaction ids and the HCS audit topic are listed
in the Hedera x402 section of the root `README.md`. A payment started from the app against the
cloud backend has not been confirmed yet.

## Mobile app on a device

`npx expo start --lan` and open it in Expo Go (SDK 58). Android and web bundles compile, but the
app has not yet been confirmed rendering on a physical phone. Camera scanning, secure-store key
generation and the local-network permission prompt are only exercised on a device.
