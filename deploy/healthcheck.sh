#!/usr/bin/env bash
# Checks the Deplao API answers on the VPS loopback (Docker container sc19-p123-deplao-1, or legacy systemd).
set -Eeuo pipefail
BASE_URL="${DEPLAO_HEALTH_URL:-http://127.0.0.1:27800}"
curl --fail --silent --show-error --max-time 15 "$BASE_URL/api/v1/health" >/dev/null
printf 'Deplao health check passed: %s\n' "$BASE_URL"
