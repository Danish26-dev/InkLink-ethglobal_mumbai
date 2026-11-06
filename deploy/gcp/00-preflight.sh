#!/usr/bin/env bash
# 00 — Preflight: who am I, which project, can I deploy? Read-only; changes nothing.
#
#   bash deploy/gcp/00-preflight.sh
#
# Shows the active account, project id/number/organization, billing, the deployer's
# IAM roles, the API status and the local tools. Exits non-zero on a blocker.
source "$(dirname "$0")/lib.sh"

blockers=0

step "Identity"
require_project
ok "account: ${DEPLOY_ACCOUNT}"
ok "project: ${PROJECT_ID} (number ${PROJECT_NUMBER})"
parent="$(gcloud projects describe "${PROJECT_ID}" --format='value(parent.type,parent.id)' 2>/dev/null | tr '\t' '/')"
if [[ "${parent}" == "organization/${ORGANIZATION_ID}" ]]; then
  ok "organization: ${ORGANIZATION_ID}"
else
  warn "parent is '${parent:-unknown}' (expected organization/${ORGANIZATION_ID})"
fi
ok "region: ${REGION} · image tag: ${TAG}"

step "Billing"
billing="$(gcloud billing projects describe "${PROJECT_ID}" --format='value(billingEnabled)' 2>/dev/null || echo unknown)"
case "${billing}" in
  True|true) ok "billing is enabled" ;;
  False|false) fail "billing is NOT enabled — link a billing account (Console → Billing)"; blockers=$((blockers + 1)) ;;
  *) warn "cannot read billing status (needs billing.resourceAssociations.list); confirm in the Console" ;;
esac

step "Deployer IAM roles (project level)"
roles="$(gcloud projects get-iam-policy "${PROJECT_ID}" --flatten='bindings[].members' \
  --filter="bindings.members:user:${DEPLOY_ACCOUNT}" --format='value(bindings.role)' 2>/dev/null || true)"
if [[ -z "${roles}" ]]; then
  warn "no direct roles found for user:${DEPLOY_ACCOUNT} (roles may come from a group, or the policy is not readable)"
else
  echo "${roles}" | sed 's/^/    /'
fi
if grep -qx 'roles/owner' <<<"${roles}"; then
  ok "roles/owner covers every step"
else
  needed=(roles/run.admin roles/artifactregistry.admin roles/cloudbuild.builds.editor roles/secretmanager.admin
          roles/storage.admin roles/iam.serviceAccountAdmin roles/iam.serviceAccountUser
          roles/serviceusage.serviceUsageAdmin roles/resourcemanager.projectIamAdmin roles/logging.viewer)
  for r in "${needed[@]}"; do
    if grep -qx "${r}" <<<"${roles}"; then ok "${r}"; else warn "missing ${r} (needed unless granted via a group/owner)"; fi
  done
fi

step "APIs"
enabled="$(gc services list --enabled --format='value(config.name)' 2>/dev/null || true)"
if [[ -z "${enabled}" ]]; then
  fail "cannot list enabled APIs (needs serviceusage.services.list)"; blockers=$((blockers + 1))
else
  missing_apis=0
  for api in "${REQUIRED_APIS[@]}"; do
    if grep -qx "${api}" <<<"${enabled}"; then ok "${api}"; else warn "${api} not enabled (01-enable-apis.sh enables it)"; missing_apis=1; fi
  done
fi

step "Organization policy that can block public services"
domains="$(gcloud resource-manager org-policies describe iam.allowedPolicyMemberDomains --project="${PROJECT_ID}" --effective --format=json 2>/dev/null || true)"
if [[ -z "${domains}" ]]; then
  warn "cannot read iam.allowedPolicyMemberDomains; if 'allUsers' is restricted, public Cloud Run services fail to deploy"
elif grep -q '"allowedValues"' <<<"${domains}"; then
  warn "domain-restricted sharing is active: '--allow-unauthenticated' (web, backend, gate) may be refused. Ask an org admin for an exception for ${PROJECT_ID}."
else
  ok "no domain restriction on allUsers"
fi

step "Existing resources"
gc artifacts repositories describe "${AR_REPO}" --location="${REGION}" --format='value(name)' >/dev/null 2>&1 \
  && ok "Artifact Registry ${AR_REPO}" || warn "Artifact Registry ${AR_REPO} not created yet (02)"
for b in "${BACKEND_BUCKET}" "${PAYMENT_BUCKET}" "${BUILD_BUCKET}"; do
  gcloud storage buckets describe "gs://${b}" --format='value(name)' >/dev/null 2>&1 && ok "bucket ${b}" || warn "bucket ${b} not created yet (02)"
done
for s in "${REQUIRED_SECRETS[@]}" "${OPTIONAL_BACKEND_SECRETS[@]}" "${PAYMENT_SECRETS[@]}"; do
  if secret_has_version "${s}"; then ok "secret ${s}"; else warn "secret ${s} has no value yet (05)"; fi
done
for svc in "${SVC_ENGINE}" "${SVC_AGENT}" "${SVC_PAYMENT}" "${SVC_GATE}" "${SVC_BACKEND}" "${SVC_WEB}"; do
  service_exists "${svc}" && ok "service ${svc}" || warn "service ${svc} not deployed yet"
done

step "Tools"
for t in git curl openssl; do command -v "${t}" >/dev/null && ok "${t}" || { fail "${t} missing"; blockers=$((blockers + 1)); }; done
command -v jq >/dev/null && ok "jq" || warn "jq missing (07 prints raw JSON)"

echo
if (( blockers > 0 )); then
  die "${blockers} blocker(s) found. Fix them before continuing."
fi
echo "${G}Preflight passed.${N} Next: bash deploy/gcp/01-enable-apis.sh"
