#!/usr/bin/env bash
# 06 — Deploy the web front door (landing page + PWA behind nginx). nginx proxies
# /api to the backend, so the browser stays on ONE origin: the SameSite=Strict shop
# session cookie and the SSE streams work exactly as in local development.
#
#   bash deploy/gcp/06-deploy-frontend.sh
source "$(dirname "$0")/lib.sh"
source "${DEPLOY_DIR}/render.sh"
require_project

step "Checks"
resolve_deploy_tag web
service_exists "${SVC_BACKEND}" || die "${SVC_BACKEND} is not deployed yet. Run 04-deploy-services.sh first."
ok "backend ${BACKEND_URL}"

step "${SVC_WEB} (public)"
reset_service_vars
S_NAME="${SVC_WEB}"; S_SA="${SA_WEB}"; S_IMAGE="${REGISTRY}/web:${TAG}"
# 512Mi is the minimum Cloud Run accepts for the gen2 execution environment.
S_PORT=8080; S_MIN=0; S_MAX=3; S_CPU=1; S_MEMORY=512Mi; S_CONCURRENCY=250
# Long timeout: /api/v1/jobs/{id}/events (SSE) streams through this service.
S_TIMEOUT=3600; S_HEALTH=/healthz
S_ENV=("BACKEND_URL=${BACKEND_URL}")
apply_service
make_public "${SVC_WEB}"

echo
echo "  landing: ${WEB_URL}/"
echo "  portal:  ${WEB_URL}/portal"
echo "  shop:    ${WEB_URL}/shop"
echo "  jury:    ${WEB_URL}/jury"
echo "${G}Frontend deployed.${N} Next: bash deploy/gcp/07-verify-deployment.sh"
