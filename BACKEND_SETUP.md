# Backend setup and API reference

The Inklink backend (`services/backend`, FastAPI) is the single authoritative job state. Other services propose, and the backend decides.

## Run locally

```powershell
cd services/backend
py -3.12 -m venv venv; .\venv\Scripts\python.exe -m pip install -r requirements.txt
copy .env.example .env        # fill in what you have; see ENVIRONMENT_SETUP.md
.\venv\Scripts\python.exe -m app.manage create-shopkeeper --email you@example.com --name "You" --shops shop_001
.\venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
.\venv\Scripts\python.exe -m pytest -q -p no:cacheprovider tests
```

Or start the whole stack with `.\scripts\dev-stack.ps1`. Then everything is served from http://localhost:5173 (`/`, `/portal`, `/app`, `/shop`, `/jury`, and `/api` proxied to `:8000`).

Admin CLI (`python -m app.manage`): `create-shopkeeper`, `list-shopkeepers`, `set-password`, `disable` (also ends that account's sessions), `register-shop`.

## Authentication

| Caller | How | Scope |
|---|---|---|
| Customer (PWA) | `POST /api/v1/web/sessions` → bearer | Own jobs; no login |
| Native app | `POST /api/v1/pairing/verify` → bearer | Claimed jobs, payments |
| Shopkeeper | `POST /api/v1/shop-auth/login` → HttpOnly `SameSite=Strict` cookie | Shops the account manages (backend-checked) |
| Admin / API | `Authorization: Bearer $SHOP_ADMIN_TOKEN` | All shops |
| Jury | `POST /api/v1/jury/sessions` → bearer | Demo shop, own demo jobs only |
| Agent / payment agent / gate / devices | service bearer tokens | Internal routes |

- Cookie writes need `X-Inklink-Request: 1` (CSRF guard).
- Logins are throttled (5 failures → 15 min).
- Sessions are stored server-side as SHA-256; logout deletes them.
- `X-Inklink-Shop` selects a managed shop per request; otherwise the session's active shop is used.

All errors use `{ "success": false, "error": { "code", "message" } }`.

## Endpoints (`/api/v1`)

**Customer and discovery:**
- `POST web/sessions`
- `GET shops` (the demo shop is shown only to jury sessions)
- `GET shops/{id}`
- `POST jobs`

**Documents:**
- `POST documents` — Contract 2. PDF/DOCX up to 25 MB. Content is validated, the page count is computed, the document is classified locally and its SHA-256 is recorded.
- `GET jobs/{id}/document?ticket&version=original|current`
- `POST jobs/{id}/document/approve|reject` — the original is never modified.
- `PUT jobs/{id}/privacy` — sets a stricter trust mode only.

**Jobs:**
- `GET jobs/{id}`
- `GET jobs/{id}/status` (Contract 8)
- `GET|POST jobs/{id}/messages` — POST starts the operator run.
- `GET jobs/{id}/history` (audit trail)
- `POST jobs/{id}/tickets`
- `GET jobs/{id}/events?ticket&after` (SSE)
- `POST jobs/{id}/quote` (Contract 4)
- `POST jobs/{id}/quote/approve` → native-app handoff

**Native app and payments:**
- `POST pairing/verify`
- `POST payment-handoffs/claim`
- `POST payments/authorizations` (Contract 5)
- `POST payments` (Contract 6)
- `GET payments/{id}` (Contract 7)

**Internal:**
- `POST internal/payment-settled` — HMAC-signed, timestamped; checks amount, network and asset; idempotent on paymentId.
- `GET internal/jobs/{id}/payment-requirements` (x402 gate)
- `POST internal/jobs/{id}/execution-requests` (agent; re-validated on the real printer)
- `POST internal/inference/v1/chat/completions` (agent grant → 0G)

**Shopkeeper auth:**
- `POST shop-auth/login`
- `GET shop-auth/me`
- `PUT shop-auth/active-shop`
- `POST shop-auth/logout`

**Shop** (scoped to the active shop):
- `GET shop/overview`
- `PUT shop/availability`
- `GET shop/jobs`
- `POST shop/jobs/{id}/approve`
- `POST shop/jobs/{id}/complete`
- `GET shop/printers`
- `GET|PUT shop/config`
- `GET shop/hardware` (gateway, adapter, printers, ESP32-S3 devices)
- `GET shop/payments`
- `GET shop/pairing-qr`

**Devices** (bearer `DEVICE_TOKEN`):
- `POST devices/heartbeat`
- `POST devices/events` — `print_started|print_completed|print_failed|paper_out|jam|door_open`. `print_completed` completes only a job the backend submitted.

**Jury:**
- `POST jury/sessions`
- `GET jury/status`
- `GET jury/state`
- `POST jury/jobs/{id}/run-fallback`
- `POST jury/jobs/{id}/approve-quote`
- `GET jury/jobs/{id}/payment`
- `POST jury/jobs/{id}/simulate-payment`
- `POST jury/jobs/{id}/simulate-execution`
- `GET jury/jobs/{id}/lifecycle`
- `POST jury/reset`

Health: `GET /health`, `GET /api/v1/health` (no secrets; 0G shows only which modes are configured).

Event types, and the order in which they are guaranteed to arrive, are documented in `docs/OPERATOR_EVENTS.md`. Web contracts are in `docs/WEB_CONTRACTS.md`.

## Execution gate

The backend prints only when all of these hold:

1. The configuration was validated by the agent and is re-validated on the live printer.
2. The customer approved the current quote.
3. The signed Hedera settlement callback was verified (`awaiting_execution`).
4. The shop approved.
5. The document is a printable PDF that is not awaiting review.

A spooler acceptance is `executing`. Only the shop, or a device `print_completed` event, marks a job `completed`. Demo-shop jobs never reach the printer.

## Data and retention

State is in-memory with an atomic JSON snapshot at `DATA_DIR/state.json`. Document files are deleted `DOCUMENT_RETENTION_HOURS` after a job's last change; paid jobs waiting to print, or printing, are kept. Logs never contain document text, prompts or completions.
