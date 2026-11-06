#!/usr/bin/env bash
# 04 — Deploy the backend services to Cloud Run, in dependency order:
#   1. inklink-document-engine   private (IAM), no state
#   2. inklink-agent             private (IAM), calls engine + backend
#   3. inklink-x402-gate         public x402 paywall      } only when payments are
#      inklink-payment-agent     private (IAM), Hedera    } fully configured
#   4. inklink-backend           public API (app-level auth), single instance
#   5. run.invoker grants between the services
# Requires 02 (resources), 05 (secrets) and 03 (images).
#
#   bash deploy/gcp/04-deploy-services.sh
source "$(dirname "$0")/lib.sh"
source "${DEPLOY_DIR}/render.sh"
require_project

step "Checks"
resolve_deploy_tag backend document-engine agent payment-agent
for s in "${REQUIRED_SECRETS[@]}"; do
  secret_has_version "${s}" || die "secret ${s} has no value. Run 05-configure-secrets.sh first."
done
ok "required secrets present"
DEPLOY_PAYMENTS=0
if payments_ready; then DEPLOY_PAYMENTS=1; ok "payments configured: gate + payment agent will be deployed"
else warn "payments not configured: gate + payment agent are skipped (the jury demo labels payment as simulated)"; fi

# Secret-backed env vars, only for secrets that hold a value.
secret_envs() { local s; for s in "$@"; do secret_has_version "${s}" && echo "${s}=${s}"; done; return 0; }

# ── 1. Document engine ──────────────────────────────────────────────────────
step "1/4 ${SVC_ENGINE} (private)"
reset_service_vars
S_NAME="${SVC_ENGINE}"; S_SA="${SA_ENGINE}"; S_IMAGE="${REGISTRY}/document-engine:${TAG}"
S_PORT=5001; S_MIN=0
# max 1: an edited output is fetched from the same instance that produced it (scratch dir).
S_MAX=1; S_CPU=2; S_MEMORY=2Gi; S_CONCURRENCY=8; S_TIMEOUT=300; S_HEALTH=/health
S_ENV=("WORK_DIR=/app/_work")
apply_service

# ── 2. Strands agent ────────────────────────────────────────────────────────
step "2/4 ${SVC_AGENT} (private)"
reset_service_vars
S_NAME="${SVC_AGENT}"; S_SA="${SA_AGENT}"; S_IMAGE="${REGISTRY}/agent:${TAG}"
S_PORT=8080; S_MIN=0; S_MAX=3; S_CPU=1; S_MEMORY=1Gi; S_CONCURRENCY=10; S_TIMEOUT=900; S_HEALTH=/api/health
S_ENV=(
  "HOST=0.0.0.0"
  "INKLINK_MODEL_PROVIDER=0g-private-computer"
  "DOCUMENT_ENGINE_URL=${ENGINE_URL}"
  "BACKEND_URL=${BACKEND_URL}"
  "PRINTER_AGENT_URL=${BACKEND_URL}/api/v1/internal/printer"
  "SERVICE_AUTH=gcp-id-token"
)
S_SECRET_ENV=("AGENT_SERVICE_TOKEN=AGENT_SERVICE_TOKEN" "PRINTER_AGENT_TOKEN=PRINTER_AGENT_TOKEN")
apply_service
grant_invoker "${SVC_ENGINE}" "serviceAccount:$(sa_email "${SA_AGENT}")"
ok "${SA_AGENT} may invoke ${SVC_ENGINE}"

# ── 3. Payments ─────────────────────────────────────────────────────────────
deploy_payment_agent=1
if (( DEPLOY_PAYMENTS )); then
  step "3/4 ${SVC_GATE} (public x402 paywall)"
  reset_service_vars
  S_NAME="${SVC_GATE}"; S_SA="${SA_GATE}"; S_IMAGE="${REGISTRY}/payment-agent:${TAG}"
  # min 1: a cold start (~10 s) outlasts the payment agent's discovery timeout, so the first
  # payment after idle would fail. Kept warm, like the agent itself.
  S_PORT=4022; S_MIN=1; S_MAX=2; S_MEMORY=512Mi; S_TIMEOUT=120
  S_COMMAND='["npm"]'; S_ARGS='["run", "gate"]'
  S_ENV=(
    "NODE_ENV=production"
    "GATE_PORT=4022"
    "HEDERA_AGENT_ACCOUNT_ID=${HEDERA_AGENT_ACCOUNT_ID}"
    "HEDERA_AGENT_PRIVATE_KEY=unused-by-gate"
    "MERCHANT_ID=${MERCHANT_ID:-shop_001}"
    "MERCHANT_ACCOUNT_ID=${MERCHANT_ACCOUNT_ID}"
    "REQUIREMENTS_URL_TEMPLATE=${BACKEND_URL}/api/v1/internal/jobs/{jobId}/payment-requirements"
    "FACILITATOR_URL=${FACILITATOR_URL:-https://api.testnet.blocky402.com}"
  )
  S_SECRET_ENV=("BACKEND_API_TOKEN=BACKEND_API_TOKEN")
  apply_service
  make_public "${SVC_GATE}"

  step "3/4 ${SVC_PAYMENT} (private, single instance: owns the spend-limit state)"
  # A rollout briefly runs the old and the new revision side by side, and both would own
  # the same spend-limit state file. So an existing payment agent is redeployed only on
  # purpose: SKIP_PAYMENT_AGENT=1 always leaves it untouched, otherwise you are asked.
  deploy_payment_agent=1
  if service_exists "${SVC_PAYMENT}"; then
    if [[ "${SKIP_PAYMENT_AGENT:-0}" == "1" ]]; then
      deploy_payment_agent=0
    elif [[ "${YES:-0}" != "1" ]]; then
      confirm "Redeploy ${SVC_PAYMENT}? Only when no payment is in progress (n = keep the running one)" \
        || deploy_payment_agent=0
    fi
  fi
fi
if (( DEPLOY_PAYMENTS )) && (( deploy_payment_agent == 0 )); then
  warn "${SVC_PAYMENT} left as it is (running revision unchanged)"
elif (( DEPLOY_PAYMENTS )); then
  reset_service_vars
  S_NAME="${SVC_PAYMENT}"; S_SA="${SA_PAYMENT}"; S_IMAGE="${REGISTRY}/payment-agent:${TAG}"
  S_PORT=4021; S_MIN=1; S_MAX=1; S_CPU_ALWAYS=true; S_MEMORY=512Mi; S_TIMEOUT=300
  S_GCS_VOLUME="/data=${PAYMENT_BUCKET}"; S_GCS_UID=1000
  S_ENV=(
    "NODE_ENV=production"
    "AGENT_STATE_FILE=/data/agent-state.json"
    "ALLOWED_RESOURCE_ORIGINS=${GATE_URL}"
    # The agent discovers the paid endpoint itself from the gate's discovery document.
    "X402_GATE_ORIGIN=${GATE_URL}"
    "BACKEND_EVENT_URL=${BACKEND_URL}/api/v1/internal/payment-settled"
    "HEDERA_AGENT_ACCOUNT_ID=${HEDERA_AGENT_ACCOUNT_ID}"
    "MERCHANT_ID=${MERCHANT_ID:-shop_001}"
    "MERCHANT_ACCOUNT_ID=${MERCHANT_ACCOUNT_ID}"
    "FACILITATOR_URL=${FACILITATOR_URL:-https://api.testnet.blocky402.com}"
  )
  # HCS spend audit log (topic id, public; empty = audit log off).
  [[ -n "${HCS_AUDIT_TOPIC_ID:-}" ]] && S_ENV+=("HCS_AUDIT_TOPIC_ID=${HCS_AUDIT_TOPIC_ID}")
  S_SECRET_ENV=(
    "INTERNAL_API_TOKEN=INTERNAL_API_TOKEN"
    "PAYMENT_EVENT_SIGNING_SECRET=PAYMENT_EVENT_SIGNING_SECRET"
    "HEDERA_AGENT_PRIVATE_KEY=HEDERA_AGENT_PRIVATE_KEY"
  )
  apply_service
else
  step "3/4 payments skipped"
fi

# ── 4. Backend ──────────────────────────────────────────────────────────────
step "4/4 ${SVC_BACKEND} (public API, single instance)"
reset_service_vars
S_NAME="${SVC_BACKEND}"; S_SA="${SA_BACKEND}"; S_IMAGE="${REGISTRY}/backend:${TAG}"
# min=max=1 and CPU always allocated: job state, SSE subscribers, inference grants and
# the printer relay queue live in this one process (state.json is its snapshot).
S_PORT=8080; S_MIN=1; S_MAX=1; S_CPU_ALWAYS=true; S_CPU=1; S_MEMORY=1Gi; S_CONCURRENCY=250
S_TIMEOUT=3600; S_HEALTH=/health
S_GCS_VOLUME="/data=${BACKEND_BUCKET}"; S_GCS_UID=10001
S_SECRET_FILE="/secrets/gateway|identity-key|GATEWAY_IDENTITY_KEY"
S_ENV=(
  "DATA_DIR=/data"
  "STATE_SAVE_INTERVAL_SECONDS=2"
  "GATEWAY_IDENTITY_KEY_PATH=/secrets/gateway/identity-key"
  "SESSION_COOKIE_SECURE=true"
  "SERVICE_AUTH=gcp-id-token"
  "PRINTER_MODE=relay"
  "PUBLIC_API_ORIGIN=${BACKEND_URL}"
  "BACKEND_INTERNAL_URL=${BACKEND_URL}"
  "BACKEND_ALLOWED_ORIGINS=${WEB_URL}"
  "AGENT_URL=${AGENT_URL}"
  "DOCUMENT_ENGINE_URL=${ENGINE_URL}"
  "PAYMENT_AGENT_URL=${PAYMENT_URL}"
  "GATE_URL=${GATE_URL}"
  "SHOP_ID=${SHOP_ID:-shop_001}"
  "SHOP_NAME=${SHOP_NAME:-Inklink Print Shop}"
  "SHOP_DESCRIPTION=${SHOP_DESCRIPTION:-Local print shop on the Inklink network.}"
  "GATEWAY_ID=${GATEWAY_ID:-gateway_001}"
  "JURY_DEMO_ENABLED=${JURY_DEMO_ENABLED:-true}"
  "ZERO_G_DEFAULT_TRUST_MODE=${ZERO_G_DEFAULT_TRUST_MODE:-private}"
  "ZERO_G_MODEL_ID=${ZERO_G_MODEL_ID:-glm-5.3}"
  "ZERO_G_GALILEO_RPC_URL=${ZERO_G_GALILEO_RPC_URL:-}"
  "ZERO_G_GALILEO_CHAIN_ID=${ZERO_G_GALILEO_CHAIN_ID:-}"
  "INKLINK_REGISTRY_ADDRESS=${INKLINK_REGISTRY_ADDRESS:-}"
  "PRICE_PER_PAGE_MONOCHROME=${PRICE_PER_PAGE_MONOCHROME:-2.00}"
  "PRICE_PER_PAGE_COLOR=${PRICE_PER_PAGE_COLOR:-10.00}"
)
[[ -n "${BOOTSTRAP_SHOPKEEPER_EMAIL:-}" ]] && S_ENV+=(
  "BOOTSTRAP_SHOPKEEPER_EMAIL=${BOOTSTRAP_SHOPKEEPER_EMAIL}"
  "BOOTSTRAP_SHOPKEEPER_NAME=${BOOTSTRAP_SHOPKEEPER_NAME:-Shop owner}"
  # true = the BOOTSTRAP_SHOPKEEPER_PASSWORD secret is authoritative (resets the password).
  "BOOTSTRAP_SHOPKEEPER_SYNC_PASSWORD=${BOOTSTRAP_SHOPKEEPER_SYNC_PASSWORD:-false}"
)
if (( DEPLOY_PAYMENTS )); then
  S_ENV+=("MERCHANT_ACCOUNT_ID=${MERCHANT_ACCOUNT_ID}" "INR_TO_USDC_RATE=${INR_TO_USDC_RATE:-}")
fi
S_SECRET_ENV=("AGENT_SERVICE_TOKEN=AGENT_SERVICE_TOKEN" "PRINTER_AGENT_TOKEN=PRINTER_AGENT_TOKEN"
              "GATEWAY_TOKEN=GATEWAY_TOKEN" "DEVICE_TOKEN=DEVICE_TOKEN")
mapfile -t extra < <(secret_envs "${OPTIONAL_BACKEND_SECRETS[@]}")
S_SECRET_ENV+=("${extra[@]}")
if (( DEPLOY_PAYMENTS )); then
  S_SECRET_ENV+=("INTERNAL_API_TOKEN=INTERNAL_API_TOKEN" "BACKEND_API_TOKEN=BACKEND_API_TOKEN"
                 "PAYMENT_EVENT_SIGNING_SECRET=PAYMENT_EVENT_SIGNING_SECRET")
fi
apply_service
make_public "${SVC_BACKEND}"

# ── 5. Service-to-service invoker grants ────────────────────────────────────
step "Invoker grants (private services accept only these callers)"
grant_invoker "${SVC_AGENT}" "serviceAccount:$(sa_email "${SA_BACKEND}")"
ok "${SA_BACKEND} → ${SVC_AGENT}"
grant_invoker "${SVC_ENGINE}" "serviceAccount:$(sa_email "${SA_BACKEND}")"
ok "${SA_BACKEND} → ${SVC_ENGINE}"
if (( DEPLOY_PAYMENTS )); then
  grant_invoker "${SVC_PAYMENT}" "serviceAccount:$(sa_email "${SA_BACKEND}")"
  ok "${SA_BACKEND} → ${SVC_PAYMENT}"
fi

echo
echo "  backend:  ${BACKEND_URL}"
echo "  agent:    ${AGENT_URL} (private)"
echo "  engine:   ${ENGINE_URL} (private)"
(( DEPLOY_PAYMENTS )) && echo "  gate:     ${GATE_URL}" && echo "  payments: ${PAYMENT_URL} (private)"
echo "${G}Services deployed.${N} Next: bash deploy/gcp/06-deploy-frontend.sh"
