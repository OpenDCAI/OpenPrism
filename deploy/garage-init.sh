#!/usr/bin/env bash
# Idempotently set up the single-node Garage layout, the project bucket and the
# S3 access key. Reads S3_* values from the repo-root .env (or the defaults below).
set -euo pipefail

cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a

BUCKET="${S3_BUCKET:-openprism}"
KEY_ID="${S3_ACCESS_KEY_ID:-GK000000000000000000000001}"
SECRET="${S3_SECRET_ACCESS_KEY:-0000000000000000000000000000000000000000000000000000000000000001}"
DC=(docker compose)
garage() { "${DC[@]}" exec -T garage /garage "$@"; }

if ! garage layout show 2>/dev/null | grep -q "dc1"; then
  NODE_ID="$(garage node id -q | cut -d@ -f1)"
  garage layout assign -z dc1 -c 1G "$NODE_ID"
  garage layout apply --version 1
fi

garage bucket info "$BUCKET" >/dev/null 2>&1 || garage bucket create "$BUCKET"
garage key info "$KEY_ID" >/dev/null 2>&1 || garage key import --yes -n openprism-dev "$KEY_ID" "$SECRET"
garage bucket allow --read --write --owner "$BUCKET" --key "$KEY_ID"

# Direct uploads: browsers PUT binary files to the bucket, so it needs CORS for the app's origins (idempotent).
"${DC[@]}" exec -T api python manage.py configure_s3_cors

echo "Garage ready: bucket=$BUCKET key=$KEY_ID endpoint=http://localhost:3900"
