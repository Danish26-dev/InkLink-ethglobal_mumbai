# Inklink — Environment Setup (Omkar's modules)

## Prerequisites

- Node.js 20+ (developed on 24), npm 10+
- A phone with **Expo Go matching SDK 58**, or an Android/iOS simulator. Web works for a UI preview.
- For real settlement: a dedicated Hedera Testnet ECDSA account (see below).

## Install

```bash
cd packages/shared-schemas && npm install && npm run build   # rebuild after changing it
cd services/payment-agent  && npm install
cd services/mock-gateway   && npm install
cd apps/mobile             && npm install
```

`shared-schemas` is consumed from its compiled `dist/` (ESM). The agent and mock gateway read
the built output, so **run `npm run build` in `packages/shared-schemas` after editing it**.

## Secrets (never commit `.env` files)

Generate each with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
The services refuse to start without them. Values must match across services:

| Variable | Used by | Purpose |
|----------|---------|---------|
| `INTERNAL_API_TOKEN` | agent (checks), backend (sends) | bearer token for backend → agent |
| `PAYMENT_EVENT_SIGNING_SECRET` | agent (signs), backend (verifies) | HMAC for the settlement callback |
| `BACKEND_API_TOKEN` | gate (sends), backend (checks) | bearer token for the gate's requirements lookup |

## Payment agent (`services/payment-agent/.env`, template: `.env.example`)

| Variable | Meaning |
|----------|---------|
| `HEDERA_AGENT_ACCOUNT_ID` / `HEDERA_AGENT_PRIVATE_KEY` | Dedicated testnet ECDSA account (signing service only) |
| `MERCHANT_ID` / `MERCHANT_ACCOUNT_ID` | Shop id customers allowlist / its Hedera receiving account (USDC-associated) |
| `ALLOWED_RESOURCE_ORIGINS` | x402 gate origins the agent may pay (default `http://localhost:4022`) |
| `FACILITATOR_URL` | Blocky402: `https://api.testnet.blocky402.com`. No fallback. |
| `BACKEND_EVENT_URL` | Callback target (default `http://localhost:8000/api/v1/internal/payment-settled`) |
| `CALLBACK_MAX_ATTEMPTS` | Retry budget (default 8) |
| `OFFLINE_LEDGER_FILE` | OfflinePay voucher ledger (default: `offline-ledger.json` next to `AGENT_STATE_FILE`). Same rules: out of git, refuses to start if corrupt |
| `HCS_AUDIT_TOPIC_ID` | Optional HCS topic for the agent's spend audit log. Create once with `npm run setup:audit-topic` (submit key = agent key, no admin key). Unset = off |
| `AGENT_STATE_FILE` | Durable state file (default `.data/agent-state.json`). Keep it out of git and out of OneDrive/Dropbox. |
| `HTS_USDC_TOKEN_ID` / `HTS_USDC_DECIMALS` | Default testnet USDC `0.0.429274` / 6 |
| `REQUIREMENTS_URL_TEMPLATE`, `BACKEND_API_TOKEN` | Gate pricing from the backend. Unset = **DEV fixed price** |

### Hedera wallet setup

1. Create an ECDSA account at https://portal.hedera.com/ and claim testnet HBAR.
2. Put the id and key in `.env`.
3. `npm run setup:wallet -- --associate` associates USDC to the agent account.
4. Mint test USDC at https://faucet.circle.com/ (choose Hedera Testnet).
5. The **merchant** account must also be USDC-associated, or settlement fails with
   `TOKEN_NOT_ASSOCIATED_TO_ACCOUNT`. For a stand-in merchant you control, set its key in the one-time
   env var `MERCHANT_PRIVATE_KEY` (never in `.env`) and run `npm run setup:merchant`
   (DER key; `-- --ed25519` or `-- --ecdsa` for raw hex). The real merchant is the team lead's.
6. `npm run setup:wallet` until it reports ready.

## Mock backend (`services/mock-gateway`, template: `.env.example`)

Set `GATEWAY_IP` to the IPv4 of the network **your phone** is on (a laptop with Ethernet + Wi-Fi + VM
adapters can pick the wrong one; check the value it prints). It prints a scannable QR on start.
Windows may need an inbound firewall rule for port 8000 (admin PowerShell):
`New-NetFirewallRule -DisplayName "Inklink mock gateway 8000" -Direction Inbound -LocalPort 8000 -Protocol TCP -Action Allow`.

## Mobile app

- `EXPO_PUBLIC_CLOUD_ORIGIN` (optional): the cloud API origin once provisioned. Unset, the
  "Cloud backend" indicator stays off.
- The gateway address is never configured: it comes from the verified QR.
- `INKLINK_ENV=production` builds with cleartext HTTP **off** (see SECURITY.md). Default is a dev build.
- On a physical phone use Expo Go SDK 58: `npx expo start --lan` and scan the terminal QR. If the
  phone cannot reach Metro, allow inbound port 8081 and check both are on the same Wi-Fi.

## Building an installable Android APK (EAS cloud build)

The app is configured for it (`apps/mobile/eas.json`, package `com.inklink.app`). No Android SDK is
needed on your machine; Expo builds in the cloud.

1. Create a free account at https://expo.dev.
2. `cd apps/mobile`, then `npx eas-cli login`.
3. `npx eas-cli build -p android --profile preview` (answer yes when it offers to set up the project).
4. When it finishes (about 10-20 minutes) it prints a download link. Open it on the phone and install.

The `preview` profile is a **development-style build**: it allows plain HTTP to the shop gateway on
the local network, which the demo needs. The `production` profile sets `INKLINK_ENV=production`,
which turns cleartext off; use it only once the gateway serves TLS with pinning (not built yet).
The app asks only for the camera permission (to scan the shop QR).