#!/usr/bin/env bash
# 05 — Create the Secret Manager secrets and grant each service access to ONLY the
# secrets it uses. Run this BEFORE 04-deploy-services.sh (the numbering follows the
# deployment brief; the run order is 00 01 02 05 03 04 06 07).
#
#   bash deploy/gcp/05-configure-secrets.sh
#
# - values are typed with `read -s` (no echo, nothing in shell history) or generated
#   with openssl, and piped to gcloud on stdin (never a command-line argument)
# - an existing secret is kept unless you choose to add a new version
# - nothing is printed except secret NAMES
source "$(dirname "$0")/lib.sh"
require_project
command -v openssl >/dev/null || die "openssl is required"

# name | kind (generate|enter|hexkey) | description
SECRETS=(
  "AGENT_SERVICE_TOKEN|generate|backend <-> Strands agent"
  "PRINTER_AGENT_TOKEN|generate|agent -> backend printer proxy (x-printer-agent-token)"
  "GATEWAY_TOKEN|generate|shop gateway connector -> backend (also set on the shop computer)"
  "DEVICE_TOKEN|generate|ESP32-S3 devices -> backend (also flashed on the device)"
  "GATEWAY_IDENTITY_KEY|hexkey|Ed25519 seed that signs the shop QR (keep stable: paired phones pin it)"
  "SHOP_ADMIN_TOKEN|generate|break-glass bearer token for the shop dashboard (optional)"
  "ZERO_G_STANDARD_API_KEY|enter|0G Private Computer key, standard mode (optional)"
  "ZERO_G_VERIFIED_API_KEY|enter|0G Private Computer key, verified mode (optional)"
  "ZERO_G_PRIVATE_API_KEY|enter|0G Private Computer key, private mode (optional)"
  "BOOTSTRAP_SHOPKEEPER_PASSWORD|enter|first shopkeeper password, min 10 chars (optional)"
  "INTERNAL_API_TOKEN|generate|backend -> payment agent (payments)"
  "BACKEND_API_TOKEN|generate|x402 gate -> backend (payments)"
  "PAYMENT_EVENT_SIGNING_SECRET|generate|payment agent settlement callback HMAC (payments)"
  "HEDERA_AGENT_PRIVATE_KEY|enter|Hedera testnet agent account private key (payments)"
)

# Which runtime service account may read which secret.
declare -A ACCESS=(
  [AGENT_SERVICE_TOKEN]="${SA_BACKEND} ${SA_AGENT}"
  [PRINTER_AGENT_TOKEN]="${SA_BACKEND} ${SA_AGENT}"
  [GATEWAY_TOKEN]="${SA_BACKEND}"
  [DEVICE_TOKEN]="${SA_BACKEND}"
  [GATEWAY_IDENTITY_KEY]="${SA_BACKEND}"
  [SHOP_ADMIN_TOKEN]="${SA_BACKEND}"
  [ZERO_G_STANDARD_API_KEY]="${SA_BACKEND}"
  [ZERO_G_VERIFIED_API_KEY]="${SA_BACKEND}"
  [ZERO_G_PRIVATE_API_KEY]="${SA_BACKEND}"
  [BOOTSTRAP_SHOPKEEPER_PASSWORD]="${SA_BACKEND}"
  [INTERNAL_API_TOKEN]="${SA_BACKEND} ${SA_PAYMENT}"
  [BACKEND_API_TOKEN]="${SA_BACKEND} ${SA_GATE}"
  [PAYMENT_EVENT_SIGNING_SECRET]="${SA_BACKEND} ${SA_PAYMENT}"
  [HEDERA_AGENT_PRIVATE_KEY]="${SA_PAYMENT}"
)

add_version() { # name ; value on stdin
  if secret_exists "$1"; then
    gc secrets versions add "$1" --data-file=- >/dev/null
  else
    gc secrets create "$1" --replication-policy=automatic --data-file=- \
      --labels=app=inklink >/dev/null
  fi
}

for entry in "${SECRETS[@]}"; do
  IFS='|' read -r name kind desc <<<"${entry}"
  step "${name} — ${desc}"
  if secret_has_version "${name}"; then
    ok "already has a value"
    if [[ "${kind}" == "hexkey" ]]; then
      warn "rotating it un-pairs every phone; only do this on purpose"
    fi
    # Never rotate unattended (YES=1 keeps every existing value).
    [[ "${YES:-0}" == "1" ]] && continue
    answer=""
    read -r -p "  Add a NEW version of ${name}? [y/N] " answer
    [[ "${answer}" =~ ^[Yy]$ ]] || continue
  fi
  case "${kind}" in
    generate|hexkey)
      if [[ "${kind}" == "generate" ]] && ! confirm "Generate a random value for ${name}? (n = type one)"; then
        kind=enter
      else
        openssl rand -hex 32 | tr -d '\n' | add_version "${name}"
        ok "stored a random 32-byte value"
        if [[ "${name}" == "GATEWAY_TOKEN" || "${name}" == "DEVICE_TOKEN" ]]; then
          echo "    Read it later for the shop computer / device with:"
          echo "    gcloud secrets versions access latest --secret=${name} --project=${PROJECT_ID}"
        fi
        continue
      fi
      ;;
  esac
  # kind=enter
  value=""
  read -r -s -p "  Enter ${name} (input hidden, empty = skip): " value; echo
  if [[ -z "${value}" ]]; then
    warn "skipped (no value stored)"
    continue
  fi
  if [[ "${name}" == "BOOTSTRAP_SHOPKEEPER_PASSWORD" && ${#value} -lt 10 ]]; then
    warn "must be at least 10 characters; skipped"
    unset value
    continue
  fi
  printf '%s' "${value}" | add_version "${name}"
  unset value
  ok "stored"
done

step "Secret access (secretAccessor per secret, per service account)"
for name in "${!ACCESS[@]}"; do
  secret_exists "${name}" || continue
  for sa in ${ACCESS[${name}]}; do
    gc secrets add-iam-policy-binding "${name}" \
      --member="serviceAccount:$(sa_email "${sa}")" --role=roles/secretmanager.secretAccessor >/dev/null
  done
  ok "${name} → ${ACCESS[${name}]}"
done

step "Summary"
missing=0
for s in "${REQUIRED_SECRETS[@]}"; do
  if secret_has_version "${s}"; then ok "required ${s}"; else fail "required ${s} has no value"; missing=1; fi
done
any_zero_g=0
for s in ZERO_G_STANDARD_API_KEY ZERO_G_VERIFIED_API_KEY ZERO_G_PRIVATE_API_KEY; do
  secret_has_version "${s}" && any_zero_g=1
done
(( any_zero_g )) || warn "no 0G key: the print operator runs only in the labelled deterministic mode"
if payments_ready; then ok "payments: all secrets and account ids present (payment services will be deployed)"
else warn "payments: incomplete (secrets and/or HEDERA_AGENT_ACCOUNT_ID, MERCHANT_ACCOUNT_ID in env/staging.env) — payment services are skipped"; fi
(( missing == 0 )) || die "fill the required secrets, then re-run this script"
echo
echo "${G}Secrets ready.${N} Next: bash deploy/gcp/03-build-images.sh"
