#!/usr/bin/env bash
# 03 — Build all images with Cloud Build and push them to Artifact Registry.
# Uses Cloud Build (not Cloud Shell's small disk). The source upload respects
# .gcloudignore, so .env files, keys, node_modules and local data never leave.
#
#   bash deploy/gcp/03-build-images.sh            # tag = current git commit
#   TAG=demo1 bash deploy/gcp/03-build-images.sh
source "$(dirname "$0")/lib.sh"
require_project

cd "${REPO_ROOT}"
if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
  warn "the working tree has uncommitted changes; they are included in this build (tag ${TAG})"
fi
[[ -f .gcloudignore ]] || die ".gcloudignore is missing at the repo root; refusing to upload the source."

step "Cloud Build → ${REGISTRY} (tag ${TAG})"
gc builds submit . \
  --region="${REGION}" \
  --config=deploy/gcp/cloudbuild.yaml \
  --substitutions="_REGISTRY=${REGISTRY},_TAG=${TAG}" \
  --service-account="projects/${PROJECT_ID}/serviceAccounts/$(sa_email "${SA_BUILD}")" \
  --gcs-source-staging-dir="gs://${BUILD_BUCKET}/source"

step "Pushed images"
for img in backend document-engine agent payment-agent web; do
  digest="$(gc artifacts docker images describe "${REGISTRY}/${img}:${TAG}" --format='value(image_summary.digest)' 2>/dev/null || true)"
  [[ -n "${digest}" ]] && ok "${img}:${TAG} ${digest}" || die "${img}:${TAG} was not found in ${REGISTRY}"
done
echo "${TAG}" > "${DEPLOY_DIR}/.last-tag"
echo
echo "${G}Images ready.${N} Next: bash deploy/gcp/04-deploy-services.sh   (uses tag ${TAG})"
