#!/usr/bin/env bash
# Release smoke test: is the version just tagged actually being served?
#
#   deploy/smoke-release.sh https://openprism.cent-su.org 0.1.0
#
# Probes the PUBLIC URL from wherever it runs, i.e. the path a user takes through Caddy, the NodePort, nginx and the API
# (same approach as graderthan's smoke test). /api/health answers {"ok": true, "version": "<apps/api/VERSION>"}, so a
# healthy OLD pod cannot pass for a rollout that did not happen. Retries with a growing delay.
#
# Env: SMOKE_ATTEMPTS (default 6), SMOKE_DELAY seconds (default 5; attempt n waits n x delay).
set -uo pipefail

BASE="${1:?usage: smoke-release.sh BASE_URL EXPECTED_VERSION}"
WANT="${2:?usage: smoke-release.sh BASE_URL EXPECTED_VERSION}"
WANT="${WANT#v}"
ATTEMPTS="${SMOKE_ATTEMPTS:-6}"
DELAY="${SMOKE_DELAY:-5}"
BASE="${BASE%/}"

for (( i = 1; i <= ATTEMPTS; i++ )); do
  body="$(curl -fsS --max-time 10 "$BASE/api/health" 2>&1)"
  if [[ $? -eq 0 ]]; then
    # Match the whole quoted value so 0.1.0 cannot pass for 0.1.00 or 10.1.0.
    if grep -qE "\"ok\": *true" <<<"$body" && grep -qE "\"version\": *\"${WANT//./\\.}\"" <<<"$body"; then
      echo "smoke: ok - $BASE serves $WANT"
      exit 0
    fi
    why="answered, but not ok / version $WANT: ${body:0:120}"
  else
    why="no usable answer: ${body:0:120}"
  fi
  echo "smoke attempt $i/$ATTEMPTS: $why"
  (( i < ATTEMPTS )) && sleep $(( DELAY * i ))
done

echo "smoke: FAILED - $BASE did not serve $WANT after $ATTEMPTS attempts" >&2
exit 1
