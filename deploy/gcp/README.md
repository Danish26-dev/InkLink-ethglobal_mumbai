# deploy/gcp — Cloud Run deployment scripts

Target: project `inklink-513817` (fixed in `lib.sh`), region `asia-south1`. Run from Google Cloud
Shell; full walkthrough in [CLOUD_SHELL_DEPLOYMENT.md](../../CLOUD_SHELL_DEPLOYMENT.md).

| Order | Script | Does |
|---|---|---|
| 1 | `00-preflight.sh` | read-only: account, project/number/org, billing, IAM roles, APIs, org policy, resources |
| 2 | `01-enable-apis.sh` | enables the required APIs (never disables) |
| 3 | `02-create-resources.sh` | Artifact Registry repo, private buckets, service accounts, resource-level IAM |
| 4 | `05-configure-secrets.sh` | Secret Manager values (`read -s` / generated) + per-secret access |
| 5 | `03-build-images.sh` | Cloud Build → Artifact Registry (`cloudbuild.yaml`) |
| 6 | `04-deploy-services.sh` | engine → agent → gate/payment agent → backend, invoker grants |
| 7 | `06-deploy-frontend.sh` | web (landing + PWA + `/api` proxy) |
| 8 | `07-verify-deployment.sh` | health, IAM, proxy, session, SSE, relay status |

Every script stops unless the active gcloud project is `inklink-513817`, passes `--project`
explicitly, and never deletes resources. `lib.sh` holds shared settings; `render.sh` renders the
Cloud Run manifests (`rendered/`, git-ignored) applied with `gcloud run services replace`.
Non-secret settings: `env/staging.env` (from `env/staging.env.example`, git-ignored).
