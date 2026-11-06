# Environment setup

Every secret lives in a service's own git-ignored `.env`, or in your deployment's secret manager. Nothing secret goes in a React/`VITE_*` variable, in the mobile app or in git. `.env.example` (repo root) maps each variable to its file; every service also has its own `.env.example`.

Status legend: **Configured** = set on this machine · **Tested** = exercised by tests or a live run · **Pending** = needs your credentials or hardware · **Simulated** = demo-only labelled path.

## Where to enter what

| What | File | Variables | Status |
|---|---|---|---|
| Three 0G Private Computer keys | `services/backend/.env` | `ZERO_G_STANDARD_API_KEY`, `ZERO_G_VERIFIED_API_KEY`, `ZERO_G_PRIVATE_API_KEY` | **Configured and tested live**: all three modes answer; a non-sensitive PDF ran on Standard and a salary slip on Private, end to end through the agent |
| 0G model / routing | `services/backend/.env` | `ZERO_G_BASE_URL`, `ZERO_G_MODEL_ID` (default `glm-5.3`, TeeML + tools), optional `ZERO_G_{STANDARD,VERIFIED,PRIVATE}_MODEL_ID`, `ZERO_G_DEFAULT_TRUST_MODE`, `ZERO_G_TIMEOUT_SECONDS`, `ZERO_G_MAX_RETRIES`, `ZERO_G_REQUIRE_TEE_VERIFICATION` | Configured defaults |
| Hedera agent account | `services/payment-agent/.env` and `deploy/.env.gate` | `HEDERA_AGENT_ACCOUNT_ID`, `HEDERA_AGENT_PRIVATE_KEY` | Pending (Omkar) |
| Hedera merchant account | backend, payment agent, gate | `MERCHANT_ACCOUNT_ID` (identical everywhere), `MERCHANT_ID` | Pending |
| HTS-USDC / FX | `services/backend/.env` | `INR_TO_USDC_RATE` (USDC per 1 INR), `FX_SOURCE_LABEL` | Pending |
| Callback signing secret | backend + payment agent | `PAYMENT_EVENT_SIGNING_SECRET` (identical) | Pending |
| Internal payment-agent token | backend + payment agent | `INTERNAL_API_TOKEN` (identical) | Pending |
| x402 gate → backend token | backend + gate | `BACKEND_API_TOKEN` (identical) | Pending |
| Settlement callback URL | payment agent | `BACKEND_EVENT_URL=https://<backend>/api/v1/internal/payment-settled` | Pending |
| 0G Galileo RPC | `services/backend/.env` | `ZERO_G_GALILEO_RPC_URL`, `ZERO_G_GALILEO_CHAIN_ID` | Pending (contracts not in repo) |
| Galileo **deployer** key | your machine / CI only, never the backend | `ZERO_G_GALILEO_DEPLOYER_PRIVATE_KEY` | Pending |
| Galileo backend signer | `services/backend/.env` or secret manager | `ZERO_G_GALILEO_SIGNER_PRIVATE_KEY` | Pending |
| Contract addresses + ABIs | `services/backend/.env` | `INKLINK_SHOP_REGISTRY_ADDRESS`, `INKLINK_JOB_REGISTRY_ADDRESS`, `INKLINK_*_ABI_PATH` | Pending, after deployment |
| 0G Storage | `services/backend/.env` | `ZERO_G_STORAGE_INDEXER_URL` | Pending (optional) |
| Google Cloud (only if `INKLINK_MODEL_PROVIDER=vertex-ai`) | `services/strands-agent/.env` | `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `VERTEX_AI_MODEL_ID` + ADC login | Optional; not needed for 0G |
| Printer gateway | backend + `services/local-printer-agent/.env` | `PRINTER_AGENT_URL`, `PRINTER_AGENT_TOKEN` (identical) | Configured locally, tested |
| ESP32-S3 controller | backend + device firmware | `DEVICE_TOKEN` | Pending (hardware) |
| Agent ↔ backend | backend + `services/strands-agent/.env` | `AGENT_SERVICE_TOKEN` (identical) | Configured locally, tested |
| Shopkeeper accounts | backend state (no env) | `python -m app.manage create-shopkeeper ...` | Tested |

## Cloud Run deployment (staging)

On Cloud Run nothing reads a `.env` file. Secrets are Secret Manager secrets (created by
`deploy/gcp/05-configure-secrets.sh`, read with `read -s`, never echoed) and each service account can
read only its own. Non-secret settings come from `deploy/gcp/env/staging.env` (git-ignored, from
`staging.env.example`). Full table: [DEPLOYMENT_ARCHITECTURE.md](DEPLOYMENT_ARCHITECTURE.md#secrets-secret-manager).
Local `docker compose` reads one git-ignored root `.env` (from `deploy/env/compose.env.example`) and
hands each container only its variables.

New deployment variables (backend unless noted):

| Variable | Purpose | Cloud Run value |
|---|---|---|
| `PRINTER_MODE` | `direct` (backend on the shop LAN) or `relay` (shop gateway connector polls the backend) | `relay` |
| `GATEWAY_TOKEN` | bearer token of the shop gateway connector (`services/shop-gateway`, same value there) | secret |
| `PRINTER_RELAY_TIMEOUT_SECONDS` | wait for a relayed printer call (default 30) | default |
| `GATEWAY_IDENTITY_KEY_PATH` | file with the 32-byte Ed25519 QR-signing seed (raw, hex or base64) | `/secrets/gateway/identity-key` (secret `GATEWAY_IDENTITY_KEY`) |
| `PUBLIC_API_ORIGIN` | https origin signed into the shop QR as `gateway.cloudOrigin` | backend URL |
| `SERVICE_AUTH` | `gcp-id-token`: send Cloud Run ID tokens to private services (backend and agent) | `gcp-id-token` |
| `STATE_SAVE_INTERVAL_SECONDS` | coalesce `state.json` writes (0 = every change) | `2` |
| `SESSION_COOKIE_SECURE` | Secure session cookie behind HTTPS | `true` |
| `BOOTSTRAP_SHOPKEEPER_EMAIL` / `_NAME` / `_SHOPS` + secret `BOOTSTRAP_SHOPKEEPER_PASSWORD` | create the first shopkeeper at start if missing (never overwrites) | optional |
| `EXPO_PUBLIC_CLOUD_ORIGIN` (mobile, EAS `staging` profile) | cloud backend for the probe and as a last pairing candidate | backend URL |

## Generating shared secrets

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Use one fresh value per shared secret and put the same value on both sides.

## 0G verification: what is actually checked

The documentation says the 0G router reports `x_0g_trace.tee_verified` when the request asks for `verify_tee`. The live router currently omits that field. Inklink therefore records each Verified/Private call as one of the following, and never as anything stronger:

- **TEE signature verified**: the router returned `tee_verified: true`.
- **Attested provider**: the provider that served the call (`x_0g_trace.provider`) is published in `GET /v1/providers` as `tee_attested` at the requested tier (Private needs `trust_mode: private`, `verifiability: TeeML`). This is checked on every call.
- **Rejected**: `tee_verified: false`, or the serving provider does not qualify. The output is discarded.

## Rules that the code enforces

- 0G keys are read only by the backend. The agent gets a short-lived per-run grant for the backend's gateway, never a key. No endpoint returns a key (tested).
- A missing key for the trust mode a document needs stops the run before anything is sent. Another mode's key is never used.
- `SHOP_LOCAL_ACCESS` is now `false` by default; shopkeepers log in.
- `.env` and `.env.*` are git-ignored; `.env.example` files are committed and contain only empty placeholders.

## Rotate

The AWS key that was found earlier in `services/strands-agent/.env` must be rotated. It is not used by Inklink any more.
