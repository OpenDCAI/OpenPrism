#!/usr/bin/env bash
# One-time (idempotent) preparation of the cluster's hosted Postgres and MinIO for OpenPrism.
#
# Uses the root credentials only inside a short-lived Job; the app then runs with credentials this script generates
# and stores in the cluster Secret openprism-app-creds (never in GitHub). If that Secret already exists, nothing
# happens, so re-running never rotates credentials. To rotate on purpose: delete the Secret, run this, redeploy.
#
# Needs kubectl access to the cluster (KUBECONFIG) and, in the environment:
#   POSTGRES_HOST POSTGRES_PORT POSTGRES_USER POSTGRES_PASSWORD      (root)
#   MINIO_HOST MINIO_PORT MINIO_ROOT_USER MINIO_ROOT_PASSWORD        (root)
# Optional: NAMESPACE (openprism), APP_DB_USER/APP_DB_NAME (openprism), S3_BUCKET (openprism), S3_SCHEME (http),
#           PG_IMAGE, MC_IMAGE.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ns="${NAMESPACE:-openprism}"
app_user="${APP_DB_USER:-openprism}"
app_db="${APP_DB_NAME:-openprism}"
bucket="${S3_BUCKET:-openprism}"
pg_image="${PG_IMAGE:-postgres:16-alpine}"
mc_image="${MC_IMAGE:-minio/mc:latest}"   # pin once a release has been verified on the cluster
creds=openprism-app-creds

for v in POSTGRES_HOST POSTGRES_USER POSTGRES_PASSWORD MINIO_HOST MINIO_ROOT_USER MINIO_ROOT_PASSWORD; do
  [ -n "${!v:-}" ] || { echo "::error::$v is empty" >&2; exit 1; }
done
k() { kubectl -n "$ns" "$@"; }

kubectl create namespace "$ns" --dry-run=client -o yaml | kubectl apply -f - >/dev/null

if k get secret "$creds" >/dev/null 2>&1; then
  echo "bootstrap: Secret $creds already exists; nothing to do"
  exit 0
fi

work="$(mktemp -d)"; chmod 700 "$work"
cleanup() {
  k delete job openprism-bootstrap --ignore-not-found --wait=false >/dev/null 2>&1 || true
  k delete secret openprism-bootstrap-pg openprism-bootstrap-minio --ignore-not-found >/dev/null 2>&1 || true
  k delete configmap openprism-bootstrap-scripts --ignore-not-found >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

# Hex only: the password goes into a postgres:// URL unescaped.
db_password="$(openssl rand -hex 24)"
s3_secret="$(openssl rand -hex 24)"
s3_user="$app_user"

# Credentials reach kubectl through files, never through argv (visible in `ps` on the runner).
umask 077
cat > "$work/pg.env" <<ENV
PGHOST=${POSTGRES_HOST}
PGPORT=${POSTGRES_PORT:-5432}
PGUSER=${POSTGRES_USER}
PGPASSWORD=${POSTGRES_PASSWORD}
APP_DB_USER=${app_user}
APP_DB_NAME=${app_db}
APP_DB_PASSWORD=${db_password}
ENV
cat > "$work/minio.env" <<ENV
MINIO_ENDPOINT=${S3_SCHEME:-http}://${MINIO_HOST}:${MINIO_PORT:-9000}
MINIO_ROOT_USER=${MINIO_ROOT_USER}
MINIO_ROOT_PASSWORD=${MINIO_ROOT_PASSWORD}
APP_S3_USER=${s3_user}
APP_S3_SECRET=${s3_secret}
BUCKET=${bucket}
ENV
k create secret generic openprism-bootstrap-pg --from-env-file="$work/pg.env" >/dev/null
k create secret generic openprism-bootstrap-minio --from-env-file="$work/minio.env" >/dev/null
k create configmap openprism-bootstrap-scripts \
  --from-file=pg-init.sh="$here/pg-init.sh" --from-file=minio-init.sh="$here/minio-init.sh" >/dev/null

k delete job openprism-bootstrap --ignore-not-found --wait=true >/dev/null
sed -e "s|__PG_IMAGE__|${pg_image}|" -e "s|__MC_IMAGE__|${mc_image}|" "$here/job.yaml" | k apply -f - >/dev/null

echo "bootstrap: waiting for the Job"
if ! k wait --for=condition=complete job/openprism-bootstrap --timeout=600s; then
  echo "bootstrap: Job failed; logs follow" >&2
  k logs job/openprism-bootstrap --all-containers --tail=100 >&2 || true
  exit 1
fi
k logs job/openprism-bootstrap --all-containers --tail=20

# Only now, with the services prepared, record the app's credentials.
cat > "$work/app.env" <<ENV
db-password=${db_password}
s3-access-key=${s3_user}
s3-secret-key=${s3_secret}
ENV
k create secret generic "$creds" --from-env-file="$work/app.env" >/dev/null
echo "bootstrap: created Secret $creds"
