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

# Everything an operator needs to see why the Job did not finish, printed BEFORE the cleanup trap deletes it.
# `describe` lists a container's state and events and only the NAMES of the Secrets it reads, never their values.
diagnose() {
  {
    echo "::group::bootstrap diagnostics"
    echo "--- job and pods"
    k get job,pod -l app.kubernetes.io/name=bootstrap -o wide 2>&1 || true
    echo "--- job events (a pod that was never created, e.g. refused by admission or a quota, is explained here)"
    k describe job openprism-bootstrap 2>&1 | sed -n '/^Events:/,$p' || true
    echo "--- pod details (container states and events)"
    k describe pod -l app.kubernetes.io/name=bootstrap 2>&1 | sed -n '/^Init Containers:/,/^Volumes:/p;/^Events:/,$p' || true
    echo "--- namespace events"
    k get events --sort-by=.lastTimestamp 2>&1 | tail -25 || true
    echo "--- container logs"
    for pod in $(k get pods -l app.kubernetes.io/name=bootstrap -o name 2>/dev/null); do
      for c in postgres minio; do
        echo "[$pod/$c]"; k logs "$pod" -c "$c" --tail=50 --request-timeout=20s 2>&1 || true
      done
    done
    echo "::endgroup::"
  } >&2
}
fail() { echo "::error::bootstrap: $1" >&2; diagnose; exit 1; }

# Wait for the Job. A pod stuck on an image pull will not recover by waiting, so give up on that early.
timeout="${BOOTSTRAP_TIMEOUT:-600}"; pull_grace="${BOOTSTRAP_PULL_GRACE:-90}"
echo "bootstrap: waiting for the Job (up to ${timeout}s)"
start=$SECONDS; stuck_since=0
while :; do
  succeeded="$(k get job openprism-bootstrap -o jsonpath='{.status.succeeded}' 2>/dev/null || true)"
  failed="$(k get job openprism-bootstrap -o jsonpath='{.status.failed}' 2>/dev/null || true)"
  [ "${succeeded:-0}" -ge 1 ] && break
  [ "${failed:-0}" -ge 1 ] && fail "the Job failed"
  # No pod at all well after the Job was created means the cluster refused to create it (Pod Security, quota, webhook).
  pods="$(k get pods -l app.kubernetes.io/name=bootstrap -o name 2>/dev/null || true)"
  [ -z "$pods" ] && [ $((SECONDS - start)) -ge "${BOOTSTRAP_NO_POD_GRACE:-60}" ] && fail "no pod was created for the Job (see the job events)"
  waiting="$(k get pods -l app.kubernetes.io/name=bootstrap -o jsonpath='{range .items[*]}{range .status.initContainerStatuses[*]}{.state.waiting.reason}{"\n"}{end}{range .status.containerStatuses[*]}{.state.waiting.reason}{"\n"}{end}{end}' 2>/dev/null || true)"
  if grep -qE 'ImagePullBackOff|ErrImagePull|InvalidImageName|CreateContainerConfigError' <<<"$waiting"; then
    [ "$stuck_since" -eq 0 ] && stuck_since=$SECONDS
    [ $((SECONDS - stuck_since)) -ge "$pull_grace" ] && fail "a pod cannot start (image pull or container config): $(tr '\n' ' ' <<<"$waiting")"
  else
    stuck_since=0
  fi
  [ $((SECONDS - start)) -ge "$timeout" ] && fail "timed out after ${timeout}s waiting for the Job"
  sleep 5
done
k logs job/openprism-bootstrap --all-containers --tail=20 --request-timeout=20s || true

# Only now, with the services prepared, record the app's credentials.
cat > "$work/app.env" <<ENV
db-password=${db_password}
s3-access-key=${s3_user}
s3-secret-key=${s3_secret}
ENV
k create secret generic "$creds" --from-env-file="$work/app.env" >/dev/null
echo "bootstrap: created Secret $creds"
