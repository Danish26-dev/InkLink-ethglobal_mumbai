# Deploying Inklink from Google Cloud Shell

Copy-paste guide for project **`inklink-513817`** (number `765131918851`), region `asia-south1`.
Run everything in [Google Cloud Shell](https://shell.cloud.google.com) signed in with the account
that has access to the project. Nothing here needs a service-account key.

Script order: `00 → 01 → 02 → 05 → 03 → 04 → 06 → 07` (05 creates the secrets the services need,
so it runs before the build and deploy). Every script checks the active project and stops if it is
not `inklink-513817`. None of them deletes resources or disables APIs. Re-running any script is safe.

Architecture and IAM details: [DEPLOYMENT_ARCHITECTURE.md](DEPLOYMENT_ARCHITECTURE.md).

---

## 1. Verify your identity

```bash
gcloud auth list
gcloud config get-value account
```

The active account (marked `*`) must be the one with access to `inklink-513817`. If not:

```bash
gcloud auth login
```

## 2. Select the project

```bash
gcloud config set project inklink-513817
gcloud projects describe inklink-513817 --format='value(projectId,projectNumber,parent.id)'
```

Expected: `inklink-513817  765131918851  277903520264`.

## 3. Permissions and billing

`roles/owner` on the project covers every step. Otherwise you need: Cloud Run Admin, Artifact
Registry Admin, Cloud Build Editor, Secret Manager Admin, Storage Admin, Service Account Admin,
Service Account User, Service Usage Admin, Project IAM Admin, Logs Viewer.

Billing must be linked (Console → Billing → *Link a billing account*). If the organization enforces
*domain restricted sharing* (`iam.allowedPolicyMemberDomains`), public services (`allUsers`) are
refused; ask an org admin for an exception for this project. The preflight reports all of this.

## 4. Clone the repository

```bash
cd ~
git clone https://github.com/Danish26-dev/InkLink-ethglobal_mumbai.git inklink
cd inklink
git log -1 --oneline
bash deploy/gcp/00-preflight.sh
```

The preflight is read-only. It prints the account, project, number, organization, billing, your
roles, API status and existing resources, and stops on a blocker.

## 5. Non-secret settings

```bash
cp deploy/gcp/env/staging.env.example deploy/gcp/env/staging.env
nano deploy/gcp/env/staging.env     # shop name, bootstrap shopkeeper email, optional Hedera ids
```

`staging.env` is git-ignored. Leave the Hedera fields empty to deploy without payments (the jury
demo then labels payment as simulated).

## 6. Secrets in Secret Manager (no shell history)

Enable the APIs and create the resources first (they are needed for secrets and IAM):

```bash
bash deploy/gcp/01-enable-apis.sh
bash deploy/gcp/02-create-resources.sh
```

Then store the secrets:

```bash
bash deploy/gcp/05-configure-secrets.sh
```

For each secret the script either generates a random value (`openssl rand -hex 32`) or asks you to
type it with `read -s`: the value is not echoed, not stored in shell history and is piped to gcloud on
stdin. **Paste a value only after its prompt is shown** (anything typed earlier is discarded), paste
one value at a time, and check the reported character count. Values that cannot be right (a 0G key
without `sk-`, a short token, a 0G key given as the password) are refused. To correct specific
secrets later: `ONLY=ZERO_G_PRIVATE_API_KEY,BOOTSTRAP_SHOPKEEPER_PASSWORD bash deploy/gcp/05-configure-secrets.sh`. Have ready: the three 0G API keys (optional), a shopkeeper password (optional, ≥ 10
characters) and, for payments, the Hedera testnet agent private key. The script then grants each
service account access to only the secrets it uses.

To read a generated token later (for the shop computer or the ESP32):

```bash
gcloud secrets versions access latest --secret=GATEWAY_TOKEN --project=inklink-513817
```

## 7. Enable the required APIs

Done in step 6 by `01-enable-apis.sh`: Cloud Run, Artifact Registry, Cloud Build, Secret Manager,
Cloud Storage, IAM, IAM Credentials, Logging, Monitoring, Resource Manager, Service Usage.
Check at any time:

```bash
gcloud services list --enabled --project=inklink-513817
```

## 8. Build the images

```bash
bash deploy/gcp/03-build-images.sh
```

Cloud Build builds the five images in parallel (backend, document engine, agent, payment agent,
web) and pushes them to `asia-south1-docker.pkg.dev/inklink-513817/inklink`, tagged with the git
commit. The upload respects `.gcloudignore`, so `.env` files, keys and local data never leave
Cloud Shell. Takes about 8–12 minutes (LibreOffice in the engine image is the slowest part).

## 9. Deploy the services in dependency order

```bash
bash deploy/gcp/04-deploy-services.sh     # engine → agent → (gate, payment agent) → backend
bash deploy/gcp/06-deploy-frontend.sh     # web (landing + PWA + /api proxy)
```

Each service is applied from a rendered manifest (`deploy/gcp/rendered/*.yaml`, git-ignored) with
`gcloud run services replace`, so re-running converges to the same configuration.

## 10. Connectivity, CORS and callback URLs

Cloud Run URLs are deterministic, so the scripts wire everything without a second pass:

| Setting | Value |
|---|---|
| Web (browser entry) | `https://inklink-web-765131918851.asia-south1.run.app` |
| Backend API (native app, devices, gateway) | `https://inklink-backend-765131918851.asia-south1.run.app` |
| Web → backend | nginx proxies `/api/*` (same origin: no CORS needed for the PWA) |
| `BACKEND_ALLOWED_ORIGINS` | the web URL |
| Agent → backend | `BACKEND_URL` = backend URL (inference grants are origin-checked) |
| Payment callback | `BACKEND_EVENT_URL` = backend `/api/v1/internal/payment-settled` (HMAC signed) |
| Gate → backend | `REQUIREMENTS_URL_TEMPLATE` = backend `/api/v1/internal/jobs/{jobId}/payment-requirements` |
| Payment agent may pay | `ALLOWED_RESOURCE_ORIGINS` = gate URL |
| Shop QR | signed `gateway.cloudOrigin` = backend URL (`PUBLIC_API_ORIGIN`) |

## 11. Verify

```bash
bash deploy/gcp/07-verify-deployment.sh
```

Checks service readiness, public pages, the `/api` proxy, that private services refuse anonymous
calls and answer your identity token, the integration status panel, an anonymous customer session
with an SSE stream through the web origin, and whether a shop gateway is connected.

Then open the web URL `/portal`, sign in at `/shop/login` with the bootstrap shopkeeper, and connect
the shop computer (printer + ESP32): [HARDWARE_GATEWAY_SETUP.md](HARDWARE_GATEWAY_SETUP.md).

Logs:

```bash
gcloud run services logs read inklink-backend --region=asia-south1 --project=inklink-513817 --limit=100
```

## 12. Native app configuration and Android development build

In `apps/mobile/eas.json`, the `staging` profile sets `EXPO_PUBLIC_CLOUD_ORIGIN`. Replace the
placeholder with the backend URL, then build (needs an Expo account; run on any machine with Node):

```bash
cd apps/mobile
npm ci
npx eas-cli@latest login
npx eas-cli@latest build --profile staging --platform android
```

Install the APK, open the shop dashboard → Pairing, and scan the QR. Details and the Expo Go /
local development options: [NATIVE_APP_INTEGRATION.md](NATIVE_APP_INTEGRATION.md).

---

## Updating

```bash
cd ~/inklink && git pull
bash deploy/gcp/03-build-images.sh && bash deploy/gcp/04-deploy-services.sh && bash deploy/gcp/06-deploy-frontend.sh
bash deploy/gcp/07-verify-deployment.sh
```

The backend keeps its state across deploys (bucket volume, flushed on shutdown).
Once payments are live, redeploy with `SKIP_PAYMENT_AGENT=1 bash deploy/gcp/04-deploy-services.sh`
unless you mean to update the payment agent: a rollout briefly runs two revisions that share its
spend-limit state, so only redeploy it when no payment is in progress (04 asks before doing so). Roll back by
deploying an earlier tag: `TAG=<sha> bash deploy/gcp/04-deploy-services.sh`.
