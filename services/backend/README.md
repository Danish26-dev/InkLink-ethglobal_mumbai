# Inklink Backend (FastAPI)

The main Inklink backend. It owns the **single authoritative job state** and
connects the web app, the native app and the internal services.

```
web app / native app ──▶ backend ──▶ strands-agent  (Print Operator Harness, NDJSON events)
                            │  ├──▶ document engine (edited output, scratch cleanup)
                            │  └──▶ local printer adapter (discovery, validation, print)
                            └──▶ payment agent ──▶ x402 gate ──▶ Hedera
                            ▲                                  │
                            └──── signed settlement callback ──┘
```

Browsers follow a job live over SSE: `GET /api/v1/jobs/{jobId}/events`.

## What it does

| Area | Endpoints |
|---|---|
| Anonymous web session (no login, no wallet) | `POST /api/v1/web/sessions` |
| Shop channels | `GET /api/v1/shops`, `GET /api/v1/shops/{shopId}` (Contract 1) |
| Jobs | `POST /api/v1/jobs` (Contract 3), `GET /api/v1/jobs/{id}`, `GET /api/v1/jobs/{id}/status` (Contract 8) |
| Upload | `POST /api/v1/documents` (Contract 2, PDF/DOCX, 25 MB, `Idempotency-Key`) |
| Conversation → print operator run | `GET/POST /api/v1/jobs/{id}/messages` |
| Preview | `GET /api/v1/jobs/{id}/document?ticket=…&version=original\|current` |
| Quote | `POST /api/v1/jobs/{id}/quote` (Contract 4) |
| Customer approval → native handoff | `POST /api/v1/jobs/{id}/quote/approve` |
| Native pairing | `POST /api/v1/pairing/verify` (Ed25519 challenge, session) |
| Handoff claim (native) | `POST /api/v1/payment-handoffs/claim` |
| Payments (native) | `POST /api/v1/payments/authorizations`, `POST /api/v1/payments`, `GET /api/v1/payments/{id}` (Contracts 5-7) |
| Settlement callback | `POST /api/v1/internal/payment-settled` (HMAC, 5-min window, idempotent) |
| Gate price lookup | `GET /api/v1/internal/jobs/{id}/payment-requirements` |
| Operator execution request | `POST /api/v1/internal/jobs/{id}/execution-requests` |
| Events | `POST /api/v1/jobs/{id}/tickets`, `GET /api/v1/jobs/{id}/events?ticket=…` |
| Shop dashboard | `/api/v1/shop/overview`, `availability`, `jobs`, `jobs/{id}/approve`, `jobs/{id}/complete`, `printers`, `config`, `pairing-qr` |

The payment, pairing and callback logic follows `services/mock-gateway`
(the teammate reference) and `docs/API_CONTRACTS.md`; the wire-format vectors
from that document are pinned in `tests/test_wire_format.py`.

## Physical execution gate

A job is submitted to the printer adapter only when **all** hold:

1. the agent validated the print configuration **and** the backend re-validated
   it with the printer adapter right before submission;
2. the customer approved the current quote;
3. payment is `settled` — only from the verified, signed callback — which moves
   the job to `awaiting_execution` (never `completed`);
4. the shop approved the job in the dashboard;
5. the document is a PDF (the printer adapter prints PDF only).

A spooler acceptance is reported as `executing`. Only the shop marks a job
`completed`, because the adapter cannot observe paper output.

## Run

```powershell
py -3.12 -m venv venv
.\venv\Scripts\python.exe -m pip install -r requirements.txt
copy .env.example .env   # fill in tokens; never commit .env
.\venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Environment variables are read from the process environment (load `.env`
with your shell or a process manager).

## Tests

```powershell
.\venv\Scripts\python.exe -m pytest -q tests
```

## Known gaps (reported, not mocked)

- **Native deep link:** the handoff link `inklink://pay?handoff=…` and
  `POST /payment-handoffs/claim` are new; the Expo app does not handle them yet.
- **DOCX printing:** the printer adapter prints PDF only and the document engine
  keeps the uploaded format, so DOCX jobs stop at the execution gate.
- **Traditional payment:** no flow exists; quotes only offer `hedera_x402`
  when payments are configured.
- **Single process:** state is in memory with a JSON snapshot in `DATA_DIR`;
  run one backend instance.

## 0G Private Computer (three trust modes)

The backend is the only component that holds 0G credentials. Put them in `services/backend/.env` (see `.env.example`), never in a frontend env:

```env
ZERO_G_BASE_URL=https://router-api.0g.ai/v1
ZERO_G_STANDARD_API_KEY=
ZERO_G_VERIFIED_API_KEY=
ZERO_G_PRIVATE_API_KEY=
ZERO_G_DEFAULT_TRUST_MODE=private
ZERO_G_MODEL_ID=glm-5.3
```

How a run is decided (`app/sensitivity.py`, `app/zerog.py`, `app/inference.py`):

1. **On upload**, the document is classified locally (PDF text via pypdf, DOCX XML). Only labels and counts are stored, never matched values or text.
2. **Required mode:**
   - Sensitive (personal, financial, identity, confidential) → `private`.
   - Unclassifiable (no readable text) → `private`.
   - Non-sensitive → `standard`.
   - No document attached → `ZERO_G_DEFAULT_TRUST_MODE`.
3. **Effective mode** = strictest of the required mode, the customer's choice (`PUT /jobs/{id}/privacy`, or words like "private" / "verifiable" in the instruction) and the shop minimum (`minimumTrustMode`). It can be raised, never lowered.
4. **Preflight**, before anything is sent:
   - The key for exactly that mode must exist. Another mode's key is never used.
   - The model must be in the live 0G catalog with a qualifying tier: `private` needs `TeeML`; `verified` needs `TeeML` or `TeeTLS`. It must also support tool calling.
   - If any check fails, the run does not start, and nothing is sent to the agent or to 0G.
5. **Grant.** The agent receives a short-lived grant for this backend's gateway (`/api/v1/internal/inference/v1`), not a 0G key.
6. **Each call through the gateway:**
   - It uses that mode's key and `X-0G-Provider-Trust-Mode: <mode>`.
   - The model is pinned and body-level `provider` overrides are stripped.
   - For `verified`/`private` it sets `verify_tee: true` and requires `x_0g_trace.tee_verified == true`; otherwise the output is discarded.
   - `503 no_provider_for_trust_mode` is reported as is. There is no retry in a weaker mode.

Call metadata (mode, model, provider address, request id, `teeVerified`) is kept per job in `inference_log`, with no prompts and no completions.

Documents: the original upload is never modified. An edited copy waits in `pending_review` until the customer approves (`POST /jobs/{id}/document/approve`) or rejects it (`.../reject`, which deletes the copy). Files are deleted `DOCUMENT_RETENTION_HOURS` after the job's last change. Paid jobs waiting to print, or printing, are kept.
