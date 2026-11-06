#!/usr/bin/env bash
# 01 — Enable the Google Cloud APIs Inklink needs. Only enables; never disables.
#
#   bash deploy/gcp/01-enable-apis.sh
source "$(dirname "$0")/lib.sh"
require_project

step "Enabling APIs on ${PROJECT_ID}"
enabled="$(gc services list --enabled --format='value(config.name)')"
to_enable=()
for api in "${REQUIRED_APIS[@]}"; do
  if grep -qx "${api}" <<<"${enabled}"; then ok "${api} (already enabled)"; else to_enable+=("${api}"); fi
done
if (( ${#to_enable[@]} > 0 )); then
  echo "  enabling: ${to_enable[*]}"
  gc services enable "${to_enable[@]}"
  for api in "${to_enable[@]}"; do ok "${api}"; done
fi
echo
echo "${G}APIs ready.${N} Next: bash deploy/gcp/02-create-resources.sh"
