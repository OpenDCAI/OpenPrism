#!/usr/bin/env bash
# Seal the app's secrets for namespace openprism (#170). Reads values from the environment (the "Seal secrets" workflow
# passes the GitHub repository secrets), never prints them, and writes SealedSecrets to deploy/argocd/secrets/.
#
#   KUBESEAL=kubeseal CERT=deploy/sealed-secrets/cent-cert.pem deploy/seal-secrets.sh
#
# Needs kubectl (only for `create secret --dry-run=client`, no cluster access) and kubeseal. Values are written to files
# in a private temporary directory and passed with --from-file, so they never appear on a command line.
set -euo pipefail
cert="${CERT:-deploy/sealed-secrets/cent-cert.pem}"
out="${OUT:-deploy/argocd/secrets}"
ns=openprism
kubeseal="${KUBESEAL:-kubeseal}"
[ -s "$cert" ] || { echo "::error::no sealing certificate at $cert (see deploy/sealed-secrets/README.md)"; exit 1; }
for v in DJANGO_SECRET_KEY CREDENTIAL_ENCRYPTION_KEY REDIS_PASSWORD REDIS_HOST REDIS_PORT GHCR_USERNAME GHCR_PASSWORD; do
  [ -n "${!v:-}" ] || { echo "::error::secret $v is empty or missing"; exit 1; }
done
python3 apps/api/common/secretcheck.py      # placeholders and weak values never get sealed (#117)

dir="$(mktemp -d)"; chmod 700 "$dir"; trap 'rm -rf "$dir"' EXIT
mkdir -p "$out"
put() { printf '%s' "$2" > "$dir/$1/$3"; }

# openprism-core: what every app container reads (envFrom). REDIS_URL is built here, as the chart did (#168).
mkdir "$dir/core"
python3 - "$dir/core/REDIS_URL" <<'PY'
import os, sys, urllib.parse
url = 'redis://:%s@%s:%s/%s' % (urllib.parse.quote(os.environ['REDIS_PASSWORD'], safe=''), os.environ['REDIS_HOST'],
                                os.environ['REDIS_PORT'], os.environ.get('REDIS_DB', '3'))
open(sys.argv[1], 'w').write(url)
PY
for k in DJANGO_SECRET_KEY DJANGO_SECRET_KEY_FALLBACKS CREDENTIAL_ENCRYPTION_KEY EMAIL_HOST_USER EMAIL_HOST_PASSWORD \
         SOCIAL_GOOGLE_CLIENT_ID SOCIAL_GOOGLE_CLIENT_SECRET SOCIAL_ORCID_CLIENT_ID SOCIAL_ORCID_CLIENT_SECRET; do
  put core "${!k:-}" "$k"
done

# openprism-ai: only worker-transfer and worker-ai read it, and only keys that are set (the chart did the same).
mkdir "$dir/ai"
for k in OPENPRISM_LLM_API_KEY OPENPRISM_LLM_ENDPOINT OPENPRISM_LLM_MODEL OPENPRISM_MINERU_TOKEN; do
  [ -n "${!k:-}" ] && put ai "${!k}" "$k"
done

# ghcr-login-secret: the images are private.
python3 - "$dir/dockerconfig.json" <<'PY'
import base64, json, os, sys
auth = base64.b64encode(f"{os.environ['GHCR_USERNAME']}:{os.environ['GHCR_PASSWORD']}".encode()).decode()
json.dump({'auths': {'ghcr.io': {'auth': auth}}}, open(sys.argv[1], 'w'))
PY

seal() {  # name, then the kubectl create secret arguments
  local name="$1"; shift
  kubectl create secret "$@" --namespace "$ns" --dry-run=client -o yaml \
    | "$kubeseal" --cert "$cert" --scope strict --format yaml --namespace "$ns" --name "$name" > "$out/$name.yaml"
  echo "sealed $name ($(grep -cE '^    [A-Za-z0-9_.]+: Ag' "$out/$name.yaml" || true) keys)"
}
seal openprism-core generic openprism-core --from-file="$dir/core"
if [ -n "$(ls -A "$dir/ai")" ]; then seal openprism-ai generic openprism-ai --from-file="$dir/ai"; else rm -f "$out/openprism-ai.yaml"; echo "no AI defaults set: openprism-ai removed"; fi
seal ghcr-login-secret generic ghcr-login-secret --type=kubernetes.io/dockerconfigjson --from-file=.dockerconfigjson="$dir/dockerconfig.json"

# A re-seal must roll the pods: the chart's checksum/secrets annotation follows this value under Argo (#168).
rev="$(date -u +%Y%m%d%H%M%S)"
sed -i -E "s/^  revision: \".*\"( .*)?$/  revision: \"$rev\"\1/" deploy/argocd/values-cent.yaml
grep -q "revision: \"$rev\"" deploy/argocd/values-cent.yaml || { echo "::error::could not bump secrets.revision"; exit 1; }
echo "secrets.revision = $rev"
