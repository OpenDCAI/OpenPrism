# OpenPrism Helm chart (cent cluster)

`deploy/helm/openprism` deploys the app tier only: `api`, `web`, `worker-compile`, `worker-transfer`, `worker-ai`, `beat`
and a per-release `migrate` Job. Postgres, Redis and MinIO are the cluster's hosted services; TLS and the public hostname
belong to the external Caddy2 (see `deploy/caddy/`, issue #67). The GitHub Actions workflow (issue #66) runs the install.

**Status: the chart renders and lints; it has never been applied to the cluster.** Treat the first deploy as a test.

## Try it locally

```bash
helm lint deploy/helm/openprism -f deploy/helm/openprism/ci/test-values.yaml
helm template openprism deploy/helm/openprism -f deploy/helm/openprism/ci/test-values.yaml -n openprism
```

`ci/test-values.yaml` holds dummy values for everything the workflow supplies. Without `image.tag` and the three
required secrets the render fails on purpose.

## How a release is installed

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

## Operating notes (carried over from the old kustomize README)

- Each API pod can use up to `ASGI_THREADS` (16) database connections plus the collaboration pool; with several replicas
  watch the Postgres `max_connections` (consider PgBouncer).
- LaTeX and plot code run untrusted input. Prefer a cluster-wide `podPidsLimit`, and consider a sandboxed runtime
  (`runtimeClassName: gvisor` or Kata) for `worker-compile` and `worker-ai`.
- User-supplied API keys live in Redis only for the length of a job, never in Secrets.
