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
