#!/usr/bin/env bash
# 07 — Verify the deployment end to end. Read-only except for one anonymous web
# session and one empty job (no document, never printed).
#
#   bash deploy/gcp/07-verify-deployment.sh
source "$(dirname "$0")/lib.sh"
require_project
command -v curl >/dev/null || die "curl is required"

failures=0
check() { # description expected_status url [curl args...]
  local desc="$1" want="$2" url="$3"; shift 3
  local got
  got="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$@" "${url}" || echo 000)"
  if [[ "${got}" == "${want}" ]]; then ok "${desc} (${got})"; else fail "${desc}: expected ${want}, got ${got} — ${url}"; failures=$((failures + 1)); fi
}
json() { if command -v jq >/dev/null; then jq "$@"; else cat; fi; }

step "Services"
for svc in "${SVC_ENGINE}" "${SVC_AGENT}" "${SVC_BACKEND}" "${SVC_WEB}"; do
  if service_exists "${svc}"; then
    ready="$(gc run services describe "${svc}" --region="${REGION}" --format='value(status.conditions[0].status)')"
    [[ "${ready}" == "True" ]] && ok "${svc} ready" || { fail "${svc} not ready"; failures=$((failures + 1)); }
  else
    fail "${svc} not deployed"; failures=$((failures + 1))
  fi
done

step "Public endpoints"
# Not /healthz: Google's front end reserves public paths ending in "z" (404 before the container).
check "web /health" 200 "${WEB_URL}/health"
check "web landing /" 200 "${WEB_URL}/"
check "web /portal (PWA route)" 200 "${WEB_URL}/portal"
check "web /shop/login (PWA route)" 200 "${WEB_URL}/shop/login"
check "web /sw.js" 200 "${WEB_URL}/sw.js"
check "backend /health" 200 "${BACKEND_URL}/health"
check "web → backend proxy /api/v1/health" 200 "${WEB_URL}/api/v1/health"
echo "  backend health:"
curl -s --max-time 20 "${BACKEND_URL}/health" | json . | sed 's/^/    /'

step "Private services refuse anonymous callers"
check "agent without identity" 403 "${AGENT_URL}/api/health"
check "engine without identity" 403 "${ENGINE_URL}/health"
if service_exists "${SVC_PAYMENT}"; then check "payment agent without identity" 403 "${PAYMENT_URL}/health"; fi

step "Private services answer an authorized caller (your identity token)"
if id_token="$(gcloud auth print-identity-token 2>/dev/null)"; then
  check "agent /api/health" 200 "${AGENT_URL}/api/health" -H "Authorization: Bearer ${id_token}"
  check "engine /health" 200 "${ENGINE_URL}/health" -H "Authorization: Bearer ${id_token}"
  unset id_token
else
  warn "cannot mint an identity token for your account; skipped"
fi

step "Agent and printer status as seen by the backend (jury integration panel)"
jury="$(curl -s --max-time 30 -X POST "${WEB_URL}/api/v1/jury/sessions" -H 'content-type: application/json' -d '{}' || true)"
jury_token="$(sed -n 's/.*"sessionToken":"\([^"]*\)".*/\1/p' <<<"${jury}")"
if [[ -n "${jury_token}" ]]; then
  curl -s --max-time 30 "${WEB_URL}/api/v1/jury/status" -H "Authorization: Bearer ${jury_token}" | json '.integrations // .' | sed 's/^/    /'
else
  warn "jury demo disabled or unreachable; skipped"
fi

step "Customer flow through the web origin (anonymous session, empty job)"
session="$(curl -s --max-time 20 -X POST "${WEB_URL}/api/v1/web/sessions")"
token="$(sed -n 's/.*"sessionToken":"\([^"]*\)".*/\1/p' <<<"${session}")"
if [[ -z "${token}" ]]; then
  fail "could not create a web session"; failures=$((failures + 1))
else
  ok "web session created"
  shops="$(curl -s --max-time 20 "${WEB_URL}/api/v1/shops" -H "Authorization: Bearer ${token}")"
  shop_id="$(sed -n 's/.*"shopId":"\([^"]*\)".*/\1/p' <<<"${shops}" | head -n1)"
  [[ -n "${shop_id}" ]] && ok "shops listed (${shop_id})" || { fail "no shop listed"; failures=$((failures + 1)); }
  job="$(curl -s --max-time 20 -X POST "${WEB_URL}/api/v1/jobs" -H "Authorization: Bearer ${token}" \
    -H 'content-type: application/json' -d "{\"shopId\":\"${shop_id}\"}")"
  job_id="$(sed -n 's/.*"jobId":"\([^"]*\)".*/\1/p' <<<"${job}")"
  if [[ -n "${job_id}" ]]; then
    ok "job ${job_id} created"
    ticket="$(curl -s --max-time 20 -X POST "${WEB_URL}/api/v1/jobs/${job_id}/tickets" -H "Authorization: Bearer ${token}" \
      | sed -n 's/.*"ticket":"\([^"]*\)".*/\1/p')"
    # SSE through nginx + Cloud Run: expect the job_status event history within 20 s.
    sse="$(curl -s -N --max-time 20 "${WEB_URL}/api/v1/jobs/${job_id}/events?ticket=${ticket}" || true)"
    if grep -q '^event: ' <<<"${sse}"; then ok "SSE stream delivers events through the web origin"
    else fail "no SSE events received"; failures=$((failures + 1)); fi
  else
    fail "could not create a job"; failures=$((failures + 1))
  fi
fi

step "Shop gateway relay"
relay="$(curl -s --max-time 20 "${BACKEND_URL}/health" | sed -n 's/.*"printer":\({[^}]*}\).*/\1/p')"
echo "    ${relay:-unknown}"
grep -q '"connected": *true' <<<"${relay}" && ok "shop gateway connected" \
  || warn "no shop gateway connected yet: start services/shop-gateway on the shop computer (HARDWARE_GATEWAY_SETUP.md)"

step "Native app"
echo "    EAS staging profile: EXPO_PUBLIC_CLOUD_ORIGIN=${BACKEND_URL}"
echo "    Pairing QR (shop dashboard → Pairing) now carries the signed cloudOrigin."

echo
if (( failures > 0 )); then die "${failures} check(s) failed."; fi
echo "${G}Deployment verified.${N}  Open ${WEB_URL}/portal"
