# Web app and shop dashboard contracts (proposed, v0.1)

Types: `packages/shared-schemas/src/web.ts`. Additive to API Contracts 1–8. All paths are under `/api/v1`. Errors use `{ success: false, error: { code, message } }`.

## Customer web app (no login, no wallet)

| method | path | auth | notes |
|---|---|---|---|
| POST | `/web/sessions` | none | anonymous short-lived session; `customerReference` is `web_…`, no PII |
| GET | `/shops` | web | `ShopChannel[]` incl. `acceptingOrders`, `agentAvailable` |
| POST | `/jobs` | web | Contract 3; 503 `SHOP_UNAVAILABLE` when the shop is paused |
| POST | `/documents` | web | Contract 2 (PDF/DOCX, 25 MB, `Idempotency-Key`) |
| GET | `/jobs/{id}` | web owner / shop | `JobView` |
| GET/POST | `/jobs/{id}/messages` | web owner | POST starts a print-operator run; 409 while a run is active |
| POST | `/jobs/{id}/tickets` | web owner / shop | single-use 60 s ticket for SSE and document preview |
| GET | `/jobs/{id}/document?ticket=&version=original\|current` | ticket | preview / download |
| POST | `/jobs/{id}/quote` | web owner | Contract 4; requires a validated config and a real page count |
| POST | `/jobs/{id}/quote/approve` | web owner | returns a `PaymentHandoff`; 409 `FACILITATOR_UNSUPPORTED` when payments are not configured |

## Payment handoff to the native app

The browser never takes payment. Approving the quote returns:

- `deepLink`: `inklink://pay?handoff=<token>`
- `qrText`: `{"type":"inklink_payment_handoff","version":"1.0","handoff":"<token>"}`

The token is opaque, single-use, short-lived and carries no amount. The native app (paired session) calls `POST /payment-handoffs/claim { handoffToken }` and continues with Contracts 5–7. A token can be claimed by one device only.

Gap: the Expo app does not handle `inklink://pay` or this QR type yet.

## Shop dashboard (bearer `SHOP_ADMIN_TOKEN`)

| method | path |
|---|---|
| GET | `/shop/overview` (availability, agent, printer adapter, payments, stats) |
| PUT | `/shop/availability` `{ acceptingOrders }` |
| GET | `/shop/jobs` |
| POST | `/shop/jobs/{id}/approve` (then tries execution; returns pending gates) |
| POST | `/shop/jobs/{id}/complete` (only from `executing`) |
| GET | `/shop/printers` (live discovery via the printer adapter) |
| GET/PUT | `/shop/config` (name, description, INR per-page prices) |
| GET | `/shop/pairing-qr` (signed shop QR, 1 h) |

## Execution gate

Printing requires all of: a config validated by the agent and re-validated by the backend, the customer's approval of the current quote, a verified settled payment (`awaiting_execution`), shop approval, and a PDF document.
