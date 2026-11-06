#!/usr/bin/env bash
# Shared settings and helpers for the Inklink Cloud Run deployment scripts.
# Sourced by every deploy/gcp/NN-*.sh script. Run the scripts from Google Cloud
# Shell (or any machine with gcloud) as a user with access to the project below.
#
# Safety rules enforced here:
#   - the project is fixed (inklink-513817) and every gcloud call passes it explicitly
#   - each script stops unless the ACTIVE gcloud project is that project
#   - nothing is ever deleted or disabled by these scripts
#   - secret values are never echoed, logged or passed on a command line

set -euo pipefail

# ── fixed identity of the target project (do not change) ──
readonly PROJECT_ID="inklink-513817"
readonly PROJECT_NUMBER="765131918851"
readonly ORGANIZATION_ID="277903520264"

# ── deployment settings (override in deploy/gcp/env/staging.env) ──
DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${DEPLOY_DIR}/../.." && pwd)"
if [[ -f "${DEPLOY_DIR}/env/staging.env" ]]; then
  # shellcheck disable=SC1091
  source "${DEPLOY_DIR}/env/staging.env"
fi

REGION="${REGION:-asia-south1}"
AR_REPO="${AR_REPO:-inklink}"
REGISTRY="${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}"
TAG_FROM_USER="${TAG:-}"
TAG="${TAG:-$(git -C "${REPO_ROOT}" rev-parse --short=12 HEAD 2>/dev/null || date +%Y%m%d%H%M%S)}"

# Deploy scripts use the tag of the last successful 03 build unless TAG is given.
resolve_deploy_tag() {
  if [[ -z "${TAG_FROM_USER}" && -f "${DEPLOY_DIR}/.last-tag" ]]; then
    TAG="$(cat "${DEPLOY_DIR}/.last-tag")"
  fi
  local img
  for img in "$@"; do
    gc artifacts docker images describe "${REGISTRY}/${img}:${TAG}" --format='value(image_summary.digest)' >/dev/null 2>&1 \
      || die "image ${REGISTRY}/${img}:${TAG} not found. Run 03-build-images.sh (or set TAG=...)."
  done
  ok "image tag ${TAG}"
}

BACKEND_BUCKET="${BACKEND_BUCKET:-${PROJECT_ID}-backend-data}"
PAYMENT_BUCKET="${PAYMENT_BUCKET:-${PROJECT_ID}-payment-data}"
BUILD_BUCKET="${BUILD_BUCKET:-${PROJECT_ID}-build-source}"

# Cloud Run services
readonly SVC_BACKEND="inklink-backend"
readonly SVC_AGENT="inklink-agent"
readonly SVC_ENGINE="inklink-document-engine"
readonly SVC_PAYMENT="inklink-payment-agent"
readonly SVC_GATE="inklink-x402-gate"
readonly SVC_WEB="inklink-web"

# Runtime service accounts (one per service, least privilege)
sa_email() { echo "$1@${PROJECT_ID}.iam.gserviceaccount.com"; }
readonly SA_BACKEND="inklink-backend"
readonly SA_AGENT="inklink-agent"
readonly SA_ENGINE="inklink-engine"
readonly SA_PAYMENT="inklink-payment"
readonly SA_GATE="inklink-gate"
readonly SA_WEB="inklink-web"
readonly SA_BUILD="inklink-build"

# Deterministic Cloud Run URLs: https://SERVICE-PROJECT_NUMBER.REGION.run.app
run_url() { echo "https://$1-${PROJECT_NUMBER}.${REGION}.run.app"; }
BACKEND_URL="$(run_url "${SVC_BACKEND}")"
AGENT_URL="$(run_url "${SVC_AGENT}")"
ENGINE_URL="$(run_url "${SVC_ENGINE}")"
PAYMENT_URL="$(run_url "${SVC_PAYMENT}")"
GATE_URL="$(run_url "${SVC_GATE}")"
WEB_URL="$(run_url "${SVC_WEB}")"

# Secrets (Secret Manager ids). REQUIRED_SECRETS must exist before 04-deploy-services.sh.
readonly REQUIRED_SECRETS=(AGENT_SERVICE_TOKEN PRINTER_AGENT_TOKEN GATEWAY_TOKEN DEVICE_TOKEN GATEWAY_IDENTITY_KEY)
readonly OPTIONAL_BACKEND_SECRETS=(ZERO_G_STANDARD_API_KEY ZERO_G_VERIFIED_API_KEY ZERO_G_PRIVATE_API_KEY SHOP_ADMIN_TOKEN BOOTSTRAP_SHOPKEEPER_PASSWORD ZERO_G_GALILEO_SIGNER_PRIVATE_KEY)
readonly PAYMENT_SECRETS=(INTERNAL_API_TOKEN BACKEND_API_TOKEN PAYMENT_EVENT_SIGNING_SECRET HEDERA_AGENT_PRIVATE_KEY)

readonly REQUIRED_APIS=(
  run.googleapis.com
  artifactregistry.googleapis.com
  cloudbuild.googleapis.com
  secretmanager.googleapis.com
  storage.googleapis.com
  iam.googleapis.com
  iamcredentials.googleapis.com
  logging.googleapis.com
  monitoring.googleapis.com
  cloudresourcemanager.googleapis.com
  serviceusage.googleapis.com
)

# ── output helpers ──
if [[ -t 1 ]]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; N=$'\e[0m'; else B=""; G=""; Y=""; R=""; N=""; fi
step() { echo; echo "${B}==> $*${N}"; }
ok()   { echo "  ${G}✔${N} $*"; }
warn() { echo "  ${Y}!${N} $*"; }
fail() { echo "  ${R}✘${N} $*"; }
die()  { echo "${R}ERROR:${N} $*" >&2; exit 1; }

gc() { gcloud --project="${PROJECT_ID}" --quiet "$@"; }

confirm() {
  [[ "${YES:-0}" == "1" ]] && return 0
  local answer
  read -r -p "  $* [y/N] " answer
  [[ "${answer}" =~ ^[Yy]$ ]]
}

# Stop unless gcloud is authenticated and the ACTIVE project is the Inklink project.
require_project() {
  command -v gcloud >/dev/null || die "gcloud is not installed (use Google Cloud Shell)."
  local account active number
  account="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -n1)"
  [[ -n "${account}" ]] || die "No active gcloud account. Run: gcloud auth login"
  active="$(gcloud config get-value project 2>/dev/null || true)"
  if [[ "${active}" != "${PROJECT_ID}" ]]; then
    die "Active gcloud project is '${active:-<none>}', expected '${PROJECT_ID}'.
       Run: gcloud config set project ${PROJECT_ID}"
  fi
  number="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)' 2>/dev/null || true)"
  [[ "${number}" == "${PROJECT_NUMBER}" ]] || die "Cannot read project ${PROJECT_ID} as ${account} (or its number is not ${PROJECT_NUMBER}). Check access."
  DEPLOY_ACCOUNT="${account}"
}

secret_exists() { gc secrets describe "$1" --format='value(name)' >/dev/null 2>&1; }
secret_has_version() {
  [[ -n "$(gc secrets versions list "$1" --filter='state=ENABLED' --limit=1 --format='value(name)' 2>/dev/null)" ]]
}
service_exists() { gc run services describe "$1" --region="${REGION}" --format='value(metadata.name)' >/dev/null 2>&1; }

# Payments are deployed only once every payment secret has a value.
payments_ready() {
  local s
  for s in "${PAYMENT_SECRETS[@]}"; do secret_has_version "${s}" || return 1; done
  [[ -n "${HEDERA_AGENT_ACCOUNT_ID:-}" && -n "${MERCHANT_ACCOUNT_ID:-}" ]]
}

# Retry a command: a newly created service account takes a while to be visible to
# other Google APIs ("Service account ... does not exist" right after creation).
retry() { # attempts delay_seconds command...
  local attempts="$1" delay="$2" i
  shift 2
  for ((i = 1; i <= attempts; i++)); do
    if "$@"; then return 0; fi
    (( i < attempts )) && { warn "not ready yet, retrying in ${delay}s (${i}/${attempts})"; sleep "${delay}"; }
  done
  return 1
}

# Wait until a service account is usable by IAM policy bindings.
wait_for_sa() { # email
  local i
  for ((i = 1; i <= 12; i++)); do
    gc iam service-accounts describe "$1" >/dev/null 2>&1 && return 0
    sleep 5
  done
  die "service account $1 is still not visible after 60 s"
}

# Grant one role on one Cloud Run service (idempotent).
grant_invoker() { # service member
  gc run services add-iam-policy-binding "$1" --region="${REGION}" \
    --member="$2" --role=roles/run.invoker --format=none
}
