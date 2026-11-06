#!/usr/bin/env bash
# 02 — Create (idempotently) the resources the services run on:
#   - Artifact Registry Docker repository   ${AR_REPO} (${REGION})
#   - private Cloud Storage buckets          backend data, payment-agent state, build source
#   - one runtime service account per service + the Cloud Build service account
#   - the minimal IAM bindings between them
# Existing resources are left as they are. Nothing is deleted.
#
#   bash deploy/gcp/02-create-resources.sh
source "$(dirname "$0")/lib.sh"
require_project

step "Artifact Registry"
if gc artifacts repositories describe "${AR_REPO}" --location="${REGION}" >/dev/null 2>&1; then
  ok "${AR_REPO} exists"
else
  gc artifacts repositories create "${AR_REPO}" --location="${REGION}" --repository-format=docker \
    --description="Inklink container images"
  ok "created ${AR_REPO}"
fi

step "Private Cloud Storage buckets"
# Uniform bucket-level access + public access prevention: objects are never public.
# Documents are reached only through the backend (never by a public or signed URL).
for b in "${BACKEND_BUCKET}" "${PAYMENT_BUCKET}" "${BUILD_BUCKET}"; do
  if gcloud storage buckets describe "gs://${b}" >/dev/null 2>&1; then
    ok "gs://${b} exists"
  else
    gcloud storage buckets create "gs://${b}" --project="${PROJECT_ID}" --location="${REGION}" \
      --uniform-bucket-level-access --public-access-prevention
    ok "created gs://${b}"
  fi
done
# Safety net under the backend's own retention (DOCUMENT_RETENTION_HOURS, default 24 h):
# document objects older than 7 days are removed even if the backend was down.
gcloud storage buckets update "gs://${BACKEND_BUCKET}" \
  --lifecycle-file="${DEPLOY_DIR}/config/backend-bucket-lifecycle.json" >/dev/null
ok "lifecycle rule on gs://${BACKEND_BUCKET} (documents/ older than 7 days)"
gcloud storage buckets update "gs://${BUILD_BUCKET}" \
  --lifecycle-file="${DEPLOY_DIR}/config/build-bucket-lifecycle.json" >/dev/null
ok "lifecycle rule on gs://${BUILD_BUCKET} (uploaded sources older than 14 days)"

step "Service accounts"
declare -A SA_DESC=(
  ["${SA_BACKEND}"]="Inklink backend (Cloud Run)"
  ["${SA_AGENT}"]="Inklink Strands agent (Cloud Run)"
  ["${SA_ENGINE}"]="Inklink document engine (Cloud Run)"
  ["${SA_PAYMENT}"]="Inklink payment agent (Cloud Run)"
  ["${SA_GATE}"]="Inklink x402 gate (Cloud Run)"
  ["${SA_WEB}"]="Inklink web front door (Cloud Run)"
  ["${SA_BUILD}"]="Inklink image builds (Cloud Build)"
)
for sa in "${SA_BACKEND}" "${SA_AGENT}" "${SA_ENGINE}" "${SA_PAYMENT}" "${SA_GATE}" "${SA_WEB}" "${SA_BUILD}"; do
  if gc iam service-accounts describe "$(sa_email "${sa}")" >/dev/null 2>&1; then
    ok "${sa} exists"
  else
    gc iam service-accounts create "${sa}" --display-name="${SA_DESC[${sa}]}"
    ok "created ${sa}"
  fi
done

step "IAM bindings (resource level, least privilege)"
# New service accounts need a short while before IAM accepts them; wait, then retry.
for sa in "${SA_BACKEND}" "${SA_AGENT}" "${SA_ENGINE}" "${SA_PAYMENT}" "${SA_GATE}" "${SA_WEB}" "${SA_BUILD}"; do
  wait_for_sa "$(sa_email "${sa}")"
done
bucket_role() { # bucket sa role
  gcloud storage buckets add-iam-policy-binding "gs://$1" \
    --member="serviceAccount:$(sa_email "$2")" --role="$3" >/dev/null
}
# Runtime data: each service only reaches its own bucket.
retry 8 10 bucket_role "${BACKEND_BUCKET}" "${SA_BACKEND}" roles/storage.objectUser \
  || die "could not grant objectUser on gs://${BACKEND_BUCKET}"
ok "${SA_BACKEND} → objectUser on gs://${BACKEND_BUCKET}"
retry 8 10 bucket_role "${PAYMENT_BUCKET}" "${SA_PAYMENT}" roles/storage.objectUser \
  || die "could not grant objectUser on gs://${PAYMENT_BUCKET}"
ok "${SA_PAYMENT} → objectUser on gs://${PAYMENT_BUCKET}"

# Builds: read the uploaded source, push images, write build logs.
retry 8 10 bucket_role "${BUILD_BUCKET}" "${SA_BUILD}" roles/storage.objectViewer \
  || die "could not grant objectViewer on gs://${BUILD_BUCKET}"
ok "${SA_BUILD} → objectViewer on gs://${BUILD_BUCKET}"
ar_writer() {
  gc artifacts repositories add-iam-policy-binding "${AR_REPO}" --location="${REGION}" \
    --member="serviceAccount:$(sa_email "${SA_BUILD}")" --role=roles/artifactregistry.writer >/dev/null
}
retry 8 10 ar_writer || die "could not grant artifactregistry.writer on ${AR_REPO}"
ok "${SA_BUILD} → artifactregistry.writer on ${AR_REPO}"
log_writer() {
  gc projects add-iam-policy-binding "${PROJECT_ID}" --condition=None \
    --member="serviceAccount:$(sa_email "${SA_BUILD}")" --role=roles/logging.logWriter >/dev/null 2>&1
}
if retry 8 10 log_writer; then
  ok "${SA_BUILD} → logging.logWriter (project)"
else
  warn "could not grant roles/logging.logWriter to ${SA_BUILD} (needs resourcemanager.projectIamAdmin). Ask a project owner, or builds cannot write logs."
fi
# The deployer must be able to run builds as, and deploy services as, these accounts.
sa_user() {
  gc iam service-accounts add-iam-policy-binding "$(sa_email "$1")" \
    --member="user:${DEPLOY_ACCOUNT}" --role=roles/iam.serviceAccountUser >/dev/null
}
for sa in "${SA_BACKEND}" "${SA_AGENT}" "${SA_ENGINE}" "${SA_PAYMENT}" "${SA_GATE}" "${SA_WEB}" "${SA_BUILD}"; do
  retry 8 10 sa_user "${sa}" || die "could not grant serviceAccountUser on ${sa}"
done
ok "${DEPLOY_ACCOUNT} → serviceAccountUser on the Inklink service accounts"

echo
echo "  Secret access and run.invoker bindings are added by 05 and 04, per secret / per service."
echo "${G}Resources ready.${N} Next: bash deploy/gcp/05-configure-secrets.sh  (then 03, 04, 06, 07)"
