# OpenPrism Helm chart (cent cluster)

`deploy/helm/openprism` deploys the app tier only: `api`, `web`, `worker-compile`, `worker-transfer`, `worker-ai`, `beat`
and a per-release `migrate` Job. Postgres, Redis and MinIO are the cluster's hosted services; TLS and the public hostname
belong to the external Caddy2 (see `deploy/caddy/`, issue #67). The GitHub Actions workflow (issue #66) runs the install. The earlier kustomize tree (`deploy/k8s`, with
kind, ingress-nginx and KEDA) was removed in v0.1.0; see git history.

**Status: deployed on the cent cluster since v0.1.0.3 (revision 2 = v0.1.0.4), serving https://openprism.cent-su.org.** The first install failed twice and the causes are in the issue history (#69 to #74); the checks that are still open are listed under *Unverified*.

## Try it locally

```bash
helm lint deploy/helm/openprism -f deploy/helm/openprism/ci/test-values.yaml
helm template openprism deploy/helm/openprism -f deploy/helm/openprism/ci/test-values.yaml -n openprism
```

`ci/test-values.yaml` holds dummy values for everything the workflow supplies. Without `image.tag` and the three
required secrets the render fails on purpose.

## One-time bootstrap (issues #64, #70, #71)

The hosted Postgres is shared, so the app gets its own role and database instead of running as root; the bucket is
created once. `deploy/bootstrap/bootstrap.sh` does it and is safe to re-run. The deploy workflow runs it on the first
deploy (only while Secret `openprism-app-creds` is missing); it can also be run alone:

- **From Actions:** workflow "Bootstrap hosted services", Run workflow, with `release_tag` = a tag whose images are
  already built (it runs the S3 step in that release's `api` image). Manual only, same runner and secrets.
- **By hand**, with `kubectl` on the cluster:

```bash
export POSTGRES_HOST=... POSTGRES_PORT=... POSTGRES_USER=... POSTGRES_PASSWORD=...   # root, used only for the role/database
export MINIO_HOST=... MINIO_PORT=... S3_ACCESS_KEY=... S3_SECRET_KEY=...             # the key pair the app will use
export API_IMAGE=ghcr.io/cent-ischool/openprism/api:vX.Y.Z                            # carries boto3
deploy/bootstrap/bootstrap.sh            # namespace defaults to openprism; needs ghcr-login-secret there
```

- A short-lived Job runs `pg-init.sh` (postgres image) and `s3-init.py` (the `api` image; plain S3 API through boto3,
  path-style, sigv4). Only after it succeeds does the script store the result in the cluster Secret
  `openprism-app-creds` (`db-password`, `s3-access-key`, `s3-secret-key`). Nothing is stored in GitHub.
- The Postgres root credentials and the S3 key pair live in two temporary Secrets deleted when the script ends, even on
  failure; they never appear in a command line or in logs.
- If `openprism-app-creds` exists it does nothing. To rotate on purpose: delete that Secret, run the bootstrap, redeploy.
- On failure the log shows the Job and pod status, their events and per-container logs before cleanup, and it gives up
  early when no pod is created or an image cannot be pulled.
- **Postgres:** role `openprism` (no superuser, createdb or createrole) owns database `openprism`, with a generated
  password; everyone else's CONNECT is revoked, and a database of that name owned by someone else is refused.
- **Object storage:** `s3-init.py` creates bucket `openprism` if it is missing and proves the key pair can write, read
  and delete in it. **It cannot create users or keys** (that is the store's admin API, not S3; the MinIO client `mc` is
  no longer distributed and its images cannot be pulled), so the app uses the key pair it is given: a dedicated one if
  the repo has the secrets `OPENPRISM_S3_ACCESS_KEY` / `OPENPRISM_S3_SECRET_KEY`, **otherwise the store's root key
  (`MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`)**. Create a dedicated key limited to the `openprism` bucket in MinIO and add
  those two secrets to stop the app running as the storage root.
- **Redis** has no per-app role on this server: the app uses the shared `REDIS_PASSWORD` and database index `redis.db` (3).
- Tested: `pg-init.sh` against Postgres 16 (idempotent, rotates the password, refuses a foreign-owned database),
  `s3-init.py` against an S3-compatible test server (creates the bucket, idempotent, leaves nothing behind), and the
  orchestration with a fake `kubectl` in five modes. **Run on the real cluster:** the manual bootstrap workflow (Postgres role and
  database, bucket, `openprism-app-creds`) and the first-deploy step succeeded; the failure diagnostics were exercised on
  the cluster by the Helm step (#73) and only against a fake `kubectl` for the bootstrap.

## Releasing (issue #66)

`.github/workflows/deploy-cent-k8s.yaml` follows graderthan's pattern: **a release is a `vX.Y.Z` tag**, never a plain
push, and it runs on the cluster's self-hosted runner (`[self-hosted, linux, cent]`). The repository is public, so the
workflow must never gain a `pull_request` trigger.

1. On the release branch bump `apps/api/VERSION`, merge to `main`, and tag `vX.Y.Z` (the tag must equal the file; the
   first job fails otherwise).
2. The workflow builds and pushes four images to `ghcr.io/cent-ischool/openprism/{api,web,worker-tex,worker-ai}:<tag>`,
   then deploys: kubeconfig from `KUBECONFIG_CENT_BASE64`, namespace and `ghcr-login-secret`, the bootstrap **only if**
   `openprism-app-creds` is missing, `helm upgrade --install --atomic --wait`, `rollout status` for every Deployment,
   and a smoke test of the public URL that requires `/api/health` to report the new version.
3. **Redeploy without rebuilding** (e.g. to retry a failed install, #73): Actions, run "Release - build images & deploy",
   set `tag` to an existing release (its images must exist) and turn `build` off. Chart, scripts and workflow come from
   the ref you run it on, so a fix on a branch can be tried against already-built images.
4. **When Helm does not become ready** the workflow does not roll back first: `deploy/diagnose.sh` prints the pods, jobs,
   events, node capacity and, per pod, container states, events and logs (also the previous run), and only then the
   release is rolled back (`helm rollback` if an earlier revision exists, else uninstalled). Run it by hand with
   `KUBECONFIG=... NAMESPACE=openprism deploy/diagnose.sh`.

**Runner disk (#69).** The images build on the shared cluster runner, one at a time, and each is removed from the runner
once pushed (only this release's tag and dangling layers; other repositories' images are left alone). The first step of
every build fails early with the free space if less than 12 GB is available under Docker's data root; plan for about
20 GB free, since the TeX image alone is ~6 GB plus its build stages. If it fails there, free space on the runner
(`docker image prune`, old `_work` directories) and re-run the workflow from the tag.

Repository secrets used: `GHCR_USERNAME`, `GHCR_PASSWORD`, `KUBECONFIG_CENT_BASE64`, `POSTGRES_HOST/PORT`,
`REDIS_HOST/PORT/PASSWORD`, `MINIO_HOST/PORT`, `DJANGO_SECRET_KEY`, `CREDENTIAL_ENCRYPTION_KEY`; for the bootstrap only,
on the first deploy: `POSTGRES_USER/PASSWORD` and the S3 key pair (`OPENPRISM_S3_ACCESS_KEY/SECRET_KEY`, falling back to `MINIO_ROOT_USER/PASSWORD`); optional: `EMAIL_HOST_USER`,
`EMAIL_HOST_PASSWORD`, `OPENPRISM_LLM_API_KEY`, `OPENPRISM_LLM_ENDPOINT`, `OPENPRISM_LLM_MODEL`,
`OPENPRISM_MINERU_TOKEN`. Secrets reach steps as environment variables and go to the chart as `--set-file` from a
temporary directory, never into script text or command lines.

The last step probes the **public** URL, so Caddy must already serve the hostname (`deploy/caddy`, issue #67). A failed
smoke test does not roll the release back (Helm has finished); fix the proxy and re-run the workflow.

`deploy/smoke-release.sh BASE_URL VERSION` can be run by hand the same way.

## How a release is installed (what the workflow runs)

```bash
helm upgrade --install openprism deploy/helm/openprism -n openprism \
  -f deploy/helm/openprism/values.yaml \
  --set-string image.tag=$GITHUB_SHA \
  --set host=... --set postgres.host=... --set redis.host=... --set s3.host=... \
  --set-file secrets.DJANGO_SECRET_KEY=... --set-file secrets.CREDENTIAL_ENCRYPTION_KEY=... \
  --set-file secrets.REDIS_PASSWORD=... \
  --atomic --wait --wait-for-jobs --timeout 20m
```

## What lives where

| Thing | Where it comes from |
|---|---|
| Postgres, Redis, MinIO addresses | `postgres.*`, `redis.*`, `s3.*` values (the workflow fills them from the `*_HOST` / `*_PORT` secrets) |
| `DATABASE_URL`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Secret `openprism-app-creds` (keys `db-password`, `s3-access-key`, `s3-secret-key`), created once by the bootstrap Job (issue #64). The chart only reads it; the password must be URL-safe (the bootstrap generates hex) |
| `REDIS_URL` | built in `openprism-core` from `redis.*` and `secrets.REDIS_PASSWORD` (URL-encoded); the database index is `redis.db` (3) because the server is shared |
| `DJANGO_SECRET_KEY`, `CREDENTIAL_ENCRYPTION_KEY` | repo secrets, passed with `--set-file` into `openprism-core`. Never change the encryption key once users have stored keys |
| LLM / MinerU defaults | optional `secrets.OPENPRISM_*`; rendered into `openprism-ai`, read only by `worker-transfer` and `worker-ai` |
| Everything else | `openprism-config` ConfigMap, from `host`, `s3`, `mail`, `config` |

## Design notes

- **One entry point.** The `web` Service is a `NodePort` (`nodePort`, default 31081; 31080 is iot-portal). The `api` Service
  keeps the name `api` because `apps/frontend/nginx.conf` proxies to `http://api:8000`.
- **Proxy depth.** `trustedProxyCount: 2` (Caddy, then the web nginx) so rate limits key on the real client.
  `DJANGO_BEHIND_TLS_PROXY=1` relies on `X-Forwarded-Proto`, which Caddy sets and nginx forwards.
- **Uploads go through the API** (`S3_DIRECT_UPLOADS=0`): MinIO is not reachable from browsers.
- **Migrations.** The Job is named `migrate-<tag>-r<revision>` (a Job's pod template is immutable, so every revision gets
  a new one and Helm removes the old). It is not a hook, so the ConfigMap and Secrets exist on first install; the other
  pods wait for it in their `wait-for-migrations` init container. Migrations must stay backward compatible across a
  rolling update.
- **Config changes roll the pods** (`checksum/config`, `checksum/secrets` annotations).
- **Workers** are one template (`templates/workers.yaml`) driven by `workers.*`. `terminationGracePeriodSeconds` must stay
  above each task's hard time limit (330 s / 1860 s / 960 s) or a rolling update kills a running job.
- **Not included (decided for the shared cluster):** Ingress, NetworkPolicies, autoscaling, Postgres/Redis/MinIO.
  See `docs/backlog.md` (v0.1.0) for what still needs checking once it runs.

## Security model

The compile worker executes documents written by whoever can edit a project, including invited guests. The layers:

1. **In the process** (`apps/api/jobs/compile.py`, `config/hardening.py`): TeX runs with an allow-listed environment (no
   credentials), no shell escape, paranoid file access (except LuaTeX, which cannot run that way), `latexmk` without its
   rc files, `biber` without config, and the worker marks itself non-dumpable so children cannot read its
   `/proc/<pid>/environ`. LuaTeX's Lua `io.open` can still read any *file* the worker's user can read, so keep
   credentials out of files in the image and out of mounted volumes.
2. **In the pod** (in the chart): non-root, read-only root filesystem, all capabilities dropped, no service-account token,
   CPU / memory / ephemeral-storage limits, seccomp `RuntimeDefault`.
3. **On the network: NOT in the chart.** The old kustomize manifests had default-deny NetworkPolicies (`worker-compile`
   could reach only DNS and the data services; the LLM-calling workers got public HTTPS only). The chart ships none
   because the cluster's CNI enforcement is unknown and the data services are now outside the namespace. **Until they
   are added, `worker-compile` can reach whatever the pod network allows**, so untrusted LaTeX has no network
   isolation beyond layers 1 and 2. They remain in git history (`deploy/k8s/base/networkpolicies.yaml` before v0.1.0)
   and are tracked in `docs/backlog.md` (v0.1.0).
4. **Stronger, optional:** run `worker-compile` and `worker-ai` under a sandboxed runtime (`runtimeClassName: gvisor` or
   Kata); the right fix for LLM-written plot code and LaTeX sharing a user with the worker process.

Secrets are split by need: only `worker-transfer` and `worker-ai` receive `openprism-ai` (LLM and MinerU keys).
User-supplied API keys never reach Kubernetes Secrets or Postgres; they live in Redis for the length of a job.

## Operating notes (carried over from the old kustomize README)

- Each API pod can use up to `ASGI_THREADS` (16) database connections plus the collaboration pool; with several replicas
  watch the Postgres `max_connections` (consider PgBouncer).
- LaTeX and plot code run untrusted input. Prefer a cluster-wide `podPidsLimit`, and consider a sandboxed runtime
  (`runtimeClassName: gvisor` or Kata) for `worker-compile` and `worker-ai`.
- User-supplied API keys live in Redis only for the length of a job, never in Secrets.
- Migrations must stay backward compatible with the previous release for the duration of a rolling update.

## Unverified

The app is serving (`/api/health` through Caddy reports the deployed version; sign-in is required for the API). Not yet
checked on the cluster, in rough order of risk:

- **Live editing** (`/api/collab` websocket) through Caddy and the NodePort, large uploads (150 MB and above) and the
  arXiv-import event stream; see `deploy/caddy/README.md`. Needs a browser session against the live site.
- **Compiling LaTeX** in `worker-compile` with a read-only root filesystem: `pdflatex`, `xelatex`, `lualatex` and
  `latexmk` inside the pod, caches under `/tmp`, and the compile hardening still holding.
- **No NetworkPolicies** are installed: `worker-compile` has no network isolation (see the security model above).
- **The app uses the object store's root S3 key** unless `OPENPRISM_S3_ACCESS_KEY` / `_SECRET_KEY` exist (see the
  bootstrap section); to change it, delete `openprism-app-creds`, add the secrets, re-run the bootstrap workflow and redeploy.
- **Registration is open** (`REGISTRATION_MODE`) and no SMTP credentials are set, so account mail may not be delivered.
- A rolling update while a compile or transfer is running (the grace periods are set, the behaviour is not tested).
