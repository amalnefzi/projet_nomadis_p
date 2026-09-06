#!/bin/sh
# Verifie que les deux services Nomadis repondent.
# Code de sortie 0 = OK, 1 = KO. Utilisable par Docker HEALTHCHECK, un cron de
# supervision, ou une sonde externe (UptimeKuma, Blackbox exporter, ...).
#
#   API_URL=http://127.0.0.1:5000 AI_URL=http://127.0.0.1:5001 ./deploy/healthcheck.sh

set -e

API_URL="${API_URL:-http://127.0.0.1:5000}"
AI_URL="${AI_URL:-http://127.0.0.1:5001}"

check() {
  name="$1"
  url="$2"
  code=$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 5 "$url" || echo "000")
  if [ "$code" = "200" ]; then
    echo "OK   $name ($url) -> $code"
    return 0
  fi
  echo "FAIL $name ($url) -> $code"
  return 1
}

rc=0
check "nomadis-api" "$API_URL/health" || rc=1
check "nomadis-ai"  "$AI_URL/health"  || rc=1

exit $rc
