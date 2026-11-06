# Deployment architecture (staging on Google Cloud Run)

Project `inklink-513817` (number `765131918851`, organization `277903520264`), region `asia-south1`.
Everything here is deployed by the scripts in `deploy/gcp/` from Google Cloud Shell. See
[CLOUD_SHELL_DEPLOYMENT.md](CLOUD_SHELL_DEPLOYMENT.md) for the step-by-step guide.

```
  Browser (landing, PWA, shop dashboard, jury)          Inklink native app (Expo, Android)
        │ https                                               │ https (signed cloudOrigin from the shop QR)
        ▼                                                     │
  inklink-web (public) ── nginx ── /api/* ──────────────┐     │
  landing build at /, PWA at /pwa, SPA routes           ▼     ▼
                                                  inklink-backend (public, FastAPI auth)
                                                  single instance · state.json + documents on
                                                  gs://inklink-513817-backend-data (GCS volume)
                     ID token ┌───────────────────────┼──────────────────────┐ ID token
                              ▼                       ▼                      ▼
                    inklink-agent (private)  inklink-document-engine   inklink-payment-agent (private)
                    Strands print operator   (private, LibreOffice)    Hedera x402 · single instance
                    0G via backend grants             ▲                state on gs://…-payment-data
                              │ ID token ─────────────┘                      │ x402
                              │                                              ▼
                              └── /api/v1/internal/printer ─▶ backend   inklink-x402-gate (public paywall)
                                                                │
            ════════════════ internet ═══════════════════════════╪═══════════════ shop LAN ═════
                                                                │ outbound HTTPS long-poll only
                                                       services/shop-gateway (shop computer)
                                                          │ loopback               │ GET /display
                                                          ▼                        ▼
                                              local printer adapter :7777     ESP32-S3 display
                                              (Windows spooler)
```

## Services

| Cloud Run service | Image | Access | Scaling | Why |
|---|---|---|---|---|
| `inklink-web` | `deploy/web/Dockerfile` (nginx-unprivileged) | public | 0–3 | Static landing + PWA; proxies `/api` so the browser has one origin (SameSite=Strict cookies, SSE). |
| `inklink-backend` | `services/backend/Dockerfile` | public, app-level auth | **1–1**, CPU always on, 3600 s timeout | Authoritative state lives in one process (jobs, SSE subscribers, inference grants, event tickets, relay queue). |
| `inklink-agent` | `services/strands-agent/Dockerfile` | private (IAM) | 0–3 | Stateless per run; holds no model key. |
| `inklink-document-engine` | `services/document-engine/Dockerfile` | private (IAM) | 0–**1** | Edited output is downloaded from the instance that produced it (scratch dir). |
| `inklink-payment-agent` | `services/payment-agent/Dockerfile` | private (IAM) | **1–1**, CPU always on | Owns the spend-limit state file; settles in the background. Deployed only when payments are configured. |
| `inklink-x402-gate` | same image, `npm run gate` | public | 0–2 | x402 paywall the payment agent pays; prices come from the backend. |

Private services are called with a Google-signed ID token in `X-Serverless-Authorization`
(`SERVICE_AUTH=gcp-id-token`). The existing app-level `Authorization: Bearer` service tokens are
still sent and still checked, so each hop has two independent checks.

## Identity and least privilege

One runtime service account per service: `inklink-backend`, `inklink-agent`, `inklink-engine`,
`inklink-payment`, `inklink-gate`, `inklink-web`, plus `inklink-build` for Cloud Build.

| Who | Gets | On |
|---|---|---|
| `inklink-backend` | `roles/run.invoker` | agent, document engine, payment agent |
| `inklink-agent` | `roles/run.invoker` | document engine |
| `inklink-backend` | `roles/storage.objectUser` | `gs://inklink-513817-backend-data` only |
| `inklink-payment` | `roles/storage.objectUser` | `gs://inklink-513817-payment-data` only |
| each service | `roles/secretmanager.secretAccessor` | only the secrets it uses (see below) |
| `inklink-build` | `artifactregistry.writer` (repo), `storage.objectViewer` (build-source bucket), `logging.logWriter` (project) | builds |
| `allUsers` | `roles/run.invoker` | web, backend, gate only |

No service-account keys are created. Cloud Run identities come from the metadata server.

## Secrets (Secret Manager)

| Secret | Read by | Notes |
|---|---|---|
| `ZERO_G_STANDARD_API_KEY`, `ZERO_G_VERIFIED_API_KEY`, `ZERO_G_PRIVATE_API_KEY` | backend | Optional; without them the operator runs only in the labelled deterministic mode. |
| `AGENT_SERVICE_TOKEN` | backend, agent | Generated. |
| `PRINTER_AGENT_TOKEN` | backend, agent | Generated; agent → backend printer proxy. |
| `GATEWAY_TOKEN` | backend | Generated; also configured on the shop computer. |
| `DEVICE_TOKEN` | backend | Generated; also flashed on the ESP32-S3. |
| `GATEWAY_IDENTITY_KEY` | backend (mounted as a file) | Ed25519 seed that signs the shop QR. Rotating it un-pairs every phone. |
| `SHOP_ADMIN_TOKEN` | backend | Optional break-glass token. |
| `BOOTSTRAP_SHOPKEEPER_PASSWORD` | backend | Optional; creates the first shopkeeper at start if missing. |
| `INTERNAL_API_TOKEN`, `PAYMENT_EVENT_SIGNING_SECRET` | backend, payment agent | Payments. |
| `BACKEND_API_TOKEN` | backend, gate | Payments. |
| `HEDERA_AGENT_PRIVATE_KEY` | payment agent | Payments; never given to the gate. |

## Data

- **Documents** are written by the backend to `DATA_DIR/documents/<job>/` on the private bucket
  `gs://inklink-513817-backend-data` (Cloud Storage FUSE volume). The bucket has uniform access and
  public access prevention; there are no public or signed object URLs. Browsers get a document only
  through the backend with a single-use, 60-second event ticket.
- **Retention**: the backend deletes documents `DOCUMENT_RETENTION_HOURS` (24 h) after the last change;
  a bucket lifecycle rule removes anything under `documents/` older than 7 days as a safety net.
- **State**: `state.json` in the same bucket, written at most every 2 s (`STATE_SAVE_INTERVAL_SECONDS`)
  and flushed on graceful shutdown (SIGTERM).
- **Firestore is not used.** State is a single JSON snapshot owned by the single backend instance.
  This is the main scaling limit (see Limitations). No Firestore indexes are configured because no
  code reads Firestore.
- No originals are stored on-chain or in a database; only hashes are queued for the 0G Galileo registry.

## Printer, ESP32 and the shop network

Cloud Run cannot reach the shop LAN, and the printer adapter / ESP32 must never be exposed. With
`PRINTER_MODE=relay` the backend queues printer calls; the **shop gateway connector**
(`services/shop-gateway`) on the shop computer long-polls the backend over outbound HTTPS, executes
the allowlisted adapter calls on loopback, and posts the results back. Print jobs carry a short-lived
document reference (not the file), downloaded with the gateway token. The connector also serves a
read-only `GET /display` for the ESP32-S3 (loopback by default). See
[HARDWARE_GATEWAY_SETUP.md](HARDWARE_GATEWAY_SETUP.md).

## Native app

The shop QR now carries a signed `gateway.cloudOrigin` (the backend URL) when `PUBLIC_API_ORIGIN` is
set. The app tries LAN addresses first, then the signed cloud origin, then the build's
`EXPO_PUBLIC_CLOUD_ORIGIN`; every candidate must pass the Ed25519 challenge-response handshake.
See [NATIVE_APP_INTEGRATION.md](NATIVE_APP_INTEGRATION.md).

## Limitations (staging)

- Backend and payment agent are single-instance by design (in-memory state). Horizontal scaling
  needs a shared store (e.g. Firestore/Redis) for jobs, events, grants, tickets and the relay queue.
- Login lockout keys on the address Cloud Run's front end connects from (X-Forwarded-For is not
  trusted, so it cannot be spoofed); this is effectively a per-account lockout.
- The document engine is capped at one instance (scratch output is per instance).
- The payment agent runs through `tsx` (its existing image); a compiled build would be smaller.
- Real Hedera settlement, the Android build, the ESP32 firmware and the GCP deployment itself were
  not exercised from the development machine (no project access, credentials or devices there).

The earlier VM-based payment hosting guide (`docs/DEPLOY_GCP.md`) remains a valid alternative for the
payment agent and gate only.
