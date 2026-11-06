# Inklink — Testing (Omkar's modules)

Each module is testable on its own, with no hardware and no funded wallet.

## Unit and interop tests

```bash
cd services/payment-agent && npm test      # 84 tests
cd apps/mobile            && npm test      # 39 tests
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
**not** real payments.

## Real settlement (needs a funded wallet)

```bash
cd services/payment-agent
npm run setup:wallet                 # balances + token association for agent and merchant
npm run setup:wallet -- --associate  # associate USDC to the agent
npm run demo:pay                     # device-signed authorization -> pay -> settle -> verify -> HashScan link
npm run demo:pay -- --negative       # overpay attempt: refused, nothing signed
```

`demo:pay` only reports success if the mirror node shows the USDC transfer to the merchant. **A real
funded settlement has not been run yet.**

## Mobile app on a device

`npx expo start --lan` and open it in Expo Go (SDK 58). Android and web bundles compile, but the
app has not yet been confirmed rendering on a physical phone. Camera scanning, secure-store key
generation and the local-network permission prompt are only exercised on a device.
