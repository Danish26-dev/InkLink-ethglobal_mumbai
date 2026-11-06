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
| PUT | `/jobs/{id}/privacy` | web owner | `{ requestedTrustMode: standard\|verified\|private\|null }`; can only make 0G inference stricter |
| POST | `/jobs/{id}/document/approve` / `reject` | web owner | accept or discard the operator's edited copy; the original is never modified |
| POST | `/jobs/{id}/quote` | web owner | Contract 4; requires a validated config, a real page count and no edit awaiting review |
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
| GET | `/shop/hardware` (printer adapter, printers, jobs at the printer) |
| GET | `/shop/payments` (payments recorded; `settled` only from a verified callback) |

On the shop computer itself (loopback, with no forwarded non-local client) the shop endpoints work without a token while `SHOP_LOCAL_ACCESS=true`. Requests from any other device need the token.

`JobView.privacy` carries the trust-mode decision and 0G call metadata (mode, model, provider address, request id, `teeVerified`). It never contains keys, prompts or completions.

## Execution gate

Printing requires all of: a config validated by the agent and re-validated by the backend, the customer's approval of the current quote, a verified settled payment (`awaiting_execution`), shop approval, and a PDF document.

## Shopkeeper authentication, jury and devices (v0.2)

- `POST /shop-auth/login {email,password}` returns `{account, shops[], activeShopId, expiresAt}` and sets the HttpOnly `inklink_shop_session` cookie.
- `GET /shop-auth/me`, `PUT /shop-auth/active-shop {shopId}` and `POST /shop-auth/logout` are the other session routes.
- Cookie-authenticated writes require `X-Inklink-Request: 1`.
- Every `/shop/*` route is scoped to the active shop, which must be one the caller manages; otherwise it returns `403 SHOP_FORBIDDEN`.
- `JobView` gains:
  - `demo`;
  - `simulation` (jury only; SIMULATED steps kept apart from `status` and `paymentStatus`);
  - `deviceEvents`.
- `ShopHardware` gains `gateway` and `devices` (`not_configured | never_seen | online | offline`).
- The jury and device routes are listed in `BACKEND_SETUP.md`.
