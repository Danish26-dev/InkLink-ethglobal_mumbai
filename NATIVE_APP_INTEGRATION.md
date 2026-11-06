# Native app (Expo) against the deployed backend

The Inklink native app (`apps/mobile`) and the web app use **the same backend**. The web app reaches
it through the web origin (`/api` proxy); the native app talks to the backend's own HTTPS URL.

## How the app finds the backend

The address is never trusted from configuration alone. The shop's signed QR (shop dashboard →
**Pairing**) carries the addresses, and every address must pass the Ed25519 challenge-response
handshake against the key pinned from the QR before the app sends anything.

Candidates, probed in parallel, first reachable wins in this order:

1. `http://<gateway.ip>:<port>` — LAN IPv4 hint (private ranges only)
2. `http://<gateway.mdns>:<port>` — `.local` name
3. `gateway.cloudOrigin` — **new**: https origin of the cloud backend, inside the signed payload
   (the backend adds it when `PUBLIC_API_ORIGIN` is set; Cloud Run sets it to the backend URL)
4. `EXPO_PUBLIC_CLOUD_ORIGIN` — the build's cloud origin, as a last resort (e.g. for shops paired
   before the QR carried a cloud origin)

Rules (enforced in `src/discovery/qr.ts`, tested in `test/discovery.test.ts`):

- `cloudOrigin` must be `https://host[:port]`: no path, query, credentials or plain http. Anything
  else makes the QR invalid. Changing it breaks the signature.
- A LAN-only QR is byte-for-byte unchanged (the field is omitted when unset), so older apps and
  older QRs keep working.
- The paired shop stores the cloud origin (`shops.gatewayCloudOrigin`, migrated with `ALTER TABLE`),
  so reconnecting works off the shop's Wi-Fi.

`EXPO_PUBLIC_CLOUD_ORIGIN` also drives the *cloud API available* probe (`/health`) on the
Connection screen.

## The app as a full customer: upload, agent edit, review, pay

The app can do everything the web customer does, against the same backend
(`https://inklink-backend-765131918851.asia-south1.run.app/api/v1`). All calls use
`Authorization: Bearer <sessionToken>` from pairing.

**1. Pair with a stable device identity (recommended).** Add the app's anonymous device key to the
handshake, so jobs it creates stay reachable after the 15-minute session renews:

```http
POST /pairing/verify
{ "challenge": "<b64url 32 bytes>",
  "devicePublicKey": "<getDeviceIdentity().devicePublicKey>",
  "deviceSignature": "<b64url Ed25519 signature by the device key over the UTF-8 challenge>" }
→ { signedChallenge, gatewayId, sessionToken, sessionExpiresAt, customerReference: "native_dev_…" }
```

Without the two fields, pairing works as before, but the identity is new on every pairing.
A wrong device signature is refused with `401 SIGNATURE_INVALID`. `reauthenticate()` must send the
same device fields.

**2. Job and document:** `POST /jobs {shopId}` → `POST /documents` (multipart: `file`, `jobId`, `shopId`, `customerId`;
PDF/DOCX up to 25 MB; `Idempotency-Key`). This is already implemented in `uploadDocument`.

**3. Talk to the print operator (Strands agent on 0G):**

| Call | Purpose |
|---|---|
| `POST /jobs/{id}/messages {text}` | e.g. "Replace Monday with Tuesday, 2 copies, colour". Starts an agent run; `409` while one runs or after payment |
| `GET /jobs/{id}/messages` | conversation: `{role: system\|customer\|agent, text, at}` |
| `GET /jobs/{id}` | full job view: operator config, document (`editStatus`, `pageCount`), quote, trust mode |
| `POST /jobs/{id}/tickets` → `GET /jobs/{id}/events?ticket=…` | live SSE events (`agent_started`, `tool_*`, `document_processed`, `configuration_updated`, `approval_required`, `agent_finished`, `job_status_updated`, `payment_status_updated`). A ticket is single-use and valid 60 s. If SSE is awkward in React Native, poll `GET /jobs/{id}` and `/messages` every 2–3 s instead |
| `PUT /jobs/{id}/privacy {requestedTrustMode}` | optional: `standard`/`verified`/`private`. It can only raise the trust mode |

**4. Review the agent's edit.** When `document.editStatus == "pending_review"`:
- preview with a fresh ticket: `GET /jobs/{id}/document?ticket=…&version=current` (or `version=original`);
- then `POST /jobs/{id}/document/approve` or `POST /jobs/{id}/document/reject`.

A job is priced on the approved document.

**5. Pay:** `POST /jobs/{id}/quote` → Contract 5 authorization → `POST /payments`. For a job the app
created itself, its signed payment request is the quote approval (no web step).

Steps 3 and 4 are optional. Without an operator run, a job the app created is priced and printed
from the `printConfig` it sent in step 2: `copies` 1–999, `colourMode` `grayscale|colour`,
`paperSize` `A4|Letter|Legal`, `orientation` `portrait|landscape`, `sides`
`one-sided|two-sided-long-edge|two-sided-short-edge` (anything else is `400`; unset fields use the
shop defaults). The verified settlement is then the print request. The shop's default online
printer is used, the config is validated against it right before printing, and the shop must still
approve the job.

Access is per job: the app sees only jobs it created or claimed through a web handoff.

## Builds

`apps/mobile/eas.json` profiles:

| Profile | `INKLINK_ENV` | Cleartext HTTP | Cloud origin |
|---|---|---|---|
| `preview` | (unset) | allowed (LAN gateway) | none |
| `staging` | `staging` | allowed (LAN gateway) | `EXPO_PUBLIC_CLOUD_ORIGIN` (set it to the backend URL) |
| `production` | `production` | **off** (needs gateway TLS + pinning) | set when production exists |

Before building staging, replace the placeholder in `eas.json`:

```json
"EXPO_PUBLIC_CLOUD_ORIGIN": "https://inklink-backend-765131918851.asia-south1.run.app"
```

Android development/staging build (needs an Expo account; Java/Android SDK are not needed for EAS):

```bash
cd apps/mobile
npm ci
npx eas-cli@latest login
npx eas-cli@latest build --profile staging --platform android
```

Local development against the cloud backend with Expo Go (JS only):

```bash
cd apps/mobile
EXPO_PUBLIC_CLOUD_ORIGIN=https://inklink-backend-765131918851.asia-south1.run.app npx expo start
```

Expo is not containerised; it runs on the developer machine / EAS.

## End-to-end check

1. Shop dashboard (`https://inklink-web-…/shop`) → **Pairing** → QR.
2. Scan it in the app. With the phone on mobile data, pairing succeeds through the cloud origin.
3. Create the job on the web, approve the quote, continue in the app with the payment handoff.
4. Payment status (`payment_status_updated`) and job status appear in both apps from the same backend.

## Checks run for this change

- `npm run typecheck` (app + tools) passes.
- `npm test`: 67 tests pass (with the OfflinePay and print-options tests from `main`), including 4 new cloud-origin tests (accepted and ordered after LAN
  addresses, non-https or path-bearing origins rejected, tampering breaks the signature, build
  fallback appended once and only when https).
- Not run: an Android build or a device test (no Android tooling or device on the development
  machine).
