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
   The migrate Job runs with `restartPolicy: Never` and a `timeout 240` around its command, so each failed attempt stays
   as its own pod with its logs (with `OnFailure` the Job controller deleted the single pod when its 900 s deadline passed,
   which hid the error in the v0.1.5 deploy, #152); `diagnose.sh` prints the Job's status and events and every attempt's logs.
   Get them later with `kubectl -n openprism logs -l app.kubernetes.io/name=migrate --tail=100`.
   The rollback does not use `--wait` (#153): it re-creates the previous revision's migrate Job, and waiting for that Job
   turned a failing database into a failed rollback too (v0.1.5: revisions 5 and 6 both `failed`, the API without ready
   pods). Instead the step checks `rollout status` of every Deployment. A release left in `failed` is not a problem for
   the next `helm upgrade`; `helm history openprism` shows the last `deployed` revision, and `helm rollback openprism <rev>`
   returns to it by hand.

## Sandboxed runtime and pids limit (#111)

**Decision (2026-11-11): no sandboxed runtime is available on the cent cluster, so the chart supports one but leaves it
off.** What was found (read-only, from the cluster host): single-node microk8s v1.36.2, cgroup v2, containerd with only
`runc` (a `kata` stanza in `containerd-template.toml` but no `kata-runtime` or `runsc` binary), no `RuntimeClass` objects,
no `--pod-max-pids` in the kubelet arguments. The node is a VMware guest with `/dev/kvm` and CPU virtualization flags, so
Kata would run, and gVisor (`runsc`) needs no KVM at all. Neither is installed; installing one changes a shared node, so
it is the cluster owner's decision (other tenants: jupyterhub, graderthan, iot-portal).

The chart: `sandbox.runtimeClassName` (default empty) sets `runtimeClassName` on `worker-compile`, `worker-transfer` and
`worker-ai`, the only pods that run untrusted input. Set it only after the RuntimeClass exists, or the pods stay Pending.
Typical gVisor setup on microk8s (host steps, not done): install `runsc` and `containerd-shim-runsc-v1`, add a `runsc`
runtime stanza to `containerd-template.toml`, restart microk8s, then
`kubectl apply -f - <<< '{"apiVersion":"node.k8s.io/v1","kind":"RuntimeClass","metadata":{"name":"gvisor"},"handler":"runsc"}'`.
Check before relying on it: gVisor's `runsc` does not support everything TeX Live and matplotlib do, so run a compile and a
plot job under it first (a `dmesg` inside the pod shows gVisor's banner).

**pids limit.** Kubernetes has no per-pod pids field; the limit is the kubelet's `--pod-max-pids` (or `podPidsLimit`),
cluster-wide, in `/var/snap/microk8s/current/args/kubelet` (then `microk8s stop && microk8s start`). A value such as 1024
stops a fork bomb inside a pod from exhausting the node while leaving the workers room (compile concurrency 2 plus TeX
child processes). It is not set today. In-process limits remain: shell escape off, `RLIMIT_CPU/FSIZE/AS` on the children
(`jobs/compile.py`, `ai/plot.py`; `RLIMIT_NPROC` cannot be used because it counts every process of the worker's uid).

## Network policies (#112)

The chart can ship NetworkPolicies (`templates/networkpolicies.yaml`, `networkPolicy.enabled`, **off by default**). **They do
nothing on the cent cluster today:** it is a single-node microk8s whose CNI is flannel (`flanneld`, no calico/cilium pods),
and flannel does not enforce NetworkPolicy. The API accepts the objects and ignores them, so do not read a green
`kubectl get networkpolicy` as protection. Check what a cluster does before relying on it: `kubectl -n kube-system get
pods | grep -iE 'calico|cilium|canal'` and `ls /var/snap/microk8s/current/args/cni-network/` (microk8s).

When enabled (needs an enforcing CNI): default deny both ways; DNS to kube-dns; web accepts 8080 from
`networkPolicy.webIngressCidrs` (Caddy reaches the NodePort from outside the pod network) and talks only to the api; pods
labelled `openprism.io/data` reach Postgres, Redis and the object store **only at `networkPolicy.dataCidrs` on their
configured ports** (required: they live outside the cluster); `openprism.io/internet` (api, worker-transfer, worker-ai)
reaches public HTTPS only, never a private, link-local or metadata address; `openprism.io/smtp` (worker-ai) reaches ports
587/465. **worker-compile has the data label only, so a document that fetches a URL cannot connect.** Pod labels come from
the templates (`internet`/`smtp` flags under `workers.*`). Adding the labels changes the pod templates, so the next deploy
restarts every Deployment once (rolling, as usual).

To turn it on: get an enforcing CNI, set `networkPolicy.enabled: true` and `networkPolicy.dataCidrs` (the addresses of
`storage.cent-su.org`), deploy, then check from a pod: `kubectl -n openprism exec deploy/worker-compile -- python -c
"import socket;socket.create_connection(('example.com',443),5)"` must time out, the api `/readyz` must stay 200 and a
compile must succeed. Kubelet probes come from the node and are allowed by Calico and Cilium; if a CNI blocks them, add
the node address to the policies.

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
  The checks that remain are GitHub issues labelled `v0.1.6` (`deploy`).

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
   and are tracked in the `v0.1.6` GitHub issues (NetworkPolicies, sandboxed runtime).
4. **Stronger, optional:** run `worker-compile` and `worker-ai` under a sandboxed runtime (`runtimeClassName: gvisor` or
   Kata); the right fix for LLM-written plot code and LaTeX sharing a user with the worker process.

Secrets are split by need: only `worker-transfer` and `worker-ai` receive `openprism-ai` (LLM and MinerU keys).
User-supplied API keys never reach Kubernetes Secrets or Postgres; they live in Redis for the length of a job.

## Invitation-only access (v0.1.2)

**Registration is by invitation by default** (`registration.mode: invite`): nobody can sign up without an invitation, so
on a new deployment, in this order:

1. Deploy, then make the first superadmin (see *Django admin*). Without one nobody can be invited.
2. Check mail works: `kubectl -n openprism exec deploy/api -- python manage.py send_test_email you@example.com`
   (needs the `mail.*` values and the SMTP secrets; invitations are sent as mail).
3. Set `registration.contactEmail` (shown on the closed pages). Existing accounts keep working; the landing page and
   `/register` do not offer sign-up.
4. Invite people in `/admin/` -> *Platform invites* -> *Invite people* (an address per line or a pasted CSV column,
   optionally with a workspace and role). Links work once and for `registration.inviteDays` (7); *Send again* replaces a
   link, *Revoke* ends it, the list shows who is sent, failed, used or expired.

A workspace invitation (an admin inviting an address with no account) also lets that address register, unless
`registration.workspaceInvitesAllowSignup: false`. To let anyone register, set the mode to `open`.

## Passkeys and social sign-in (v0.1.4)

**Passkeys** need no setup, but they are bound to the site's host: the WebAuthn relying-party id is the host of
`APP_BASE_URL` (`openprism.cent-su.org`; override with `PASSKEY_RP_ID`). Moving the site to another host invalidates every
passkey (people still have their password, linked accounts or recovery).

**Google and ORCID** are off until configured. Add the credentials as GitHub repository secrets
(`SOCIAL_GOOGLE_CLIENT_ID`, `SOCIAL_GOOGLE_CLIENT_SECRET`, `SOCIAL_ORCID_CLIENT_ID`, `SOCIAL_ORCID_CLIENT_SECRET`); the
deploy workflow passes the ones that exist, and a provider turns on when both its values are set (the sign-in page then
shows *Continue with …* and Account settings offers to link it). Create the apps with this **redirect URI**, exactly:

- Google: Cloud console -> APIs & Services -> Credentials -> OAuth client ID (Web application); authorized redirect URI
  `https://openprism.cent-su.org/api/auth/social/google/callback`.
- ORCID: Developer Tools (orcid.org -> your account -> Developer tools; use sandbox.orcid.org with
  `social.orcidSandbox: true` to test) -> register an app; redirect URI
  `https://openprism.cent-su.org/api/auth/social/orcid/callback`. ORCID shares the email only when the person made it
  visible to trusted parties, so an ORCID sign-in works for accounts that **linked** it from Account settings, not for
  signing up.

Rules worth knowing: sign-up through a provider still needs an invitation in `invite` mode (a platform or workspace
invitation for the provider's *verified* email); a provider email is used only when the provider says it is verified; an
account that has two-factor still gets the code step; accounts created by a provider have no password (they can set one
in Account settings, and confirm sensitive changes by typing their email). Check after deploying: `curl
https://<host>/api/config` lists the providers and a sign-in round-trips.

## Two-factor authentication (v0.1.3)

Everyone can turn on an authenticator-app code (and 10 one-time recovery codes) under *Account settings*. With
`auth.superadminRequireMfa: true` (the default) `/admin/` also refuses a superadmin who has none, and asks every
superadmin who has one for the code at its login form. **Upgrading from v0.1.2 cannot lock you out if you do this first:**

1. Before deploying (or right after, with `--set auth.superadminRequireMfa=false` for the first rollout), sign in to the
   app as each superadmin, open *Account settings* -> *Two-factor authentication* and turn it on; keep the recovery codes.
2. From then on, *Admin* in the account menu opens `/admin/` with no second sign-in (a one-time code, 60 seconds).
3. A superadmin who lost the phone **and** the recovery codes: another superadmin uses *Reset two-factor authentication* on
   the users list (logged, the person is mailed and signed out everywhere). If it was the only superadmin, from the shell:
   `kubectl -n openprism exec -it deploy/api -- python manage.py shell -c "from allauth.mfa.models import Authenticator as A; A.objects.filter(user__email='you@example.com').delete()"`.

Secrets are encrypted with `CREDENTIAL_ENCRYPTION_KEY`: losing that key makes every second factor unreadable (the
recovery above applies to each person).

## Django admin (v0.1.1, #79)

`https://<host>/admin/` is the Django admin for superadmins. It needs no chart change: Caddy sends everything to the `web`
Service, whose nginx proxies `/admin/` and `/static/` (the admin's CSS and JS, served by WhiteNoise from files collected
into the `api` image at build time) to the `api`. **It is public like the rest of the site**, protected by its own
login (superusers only, rate limited, and a second factor when `auth.superadminRequireMfa` is on, see *Two-factor*); to hide it from the internet restrict `/admin/` by
address in Caddy (see the Caddyfile). The first superadmin is made with `manage.py make_superadmin` inside an `api` pod (needs a terminal, `-it`, for the
password prompt when the address has no account yet; an existing account is just promoted):

```bash
kubectl -n openprism exec -it deploy/api -- python manage.py make_superadmin you@example.com
kubectl -n openprism exec -it deploy/api -- python manage.py revoke_superadmin you@example.com   # the last one cannot be removed
```

`createsuperuser` works the same way. The commands and the admin's user form refuse to leave the deployment without a
superadmin, so a locked-out installation is recoverable only by running `make_superadmin` again.

## Operating notes (carried over from the old kustomize README)

- Each API pod can use up to `ASGI_THREADS` (16) database connections plus the collaboration pool; with several replicas
  watch the Postgres `max_connections` (consider PgBouncer).
- LaTeX and plot code run untrusted input. Prefer a cluster-wide `podPidsLimit`, and consider a sandboxed runtime
  (`runtimeClassName: gvisor` or Kata) for `worker-compile` and `worker-ai`.
- User-supplied API keys live in Redis only for the length of a job, never in Secrets.
- Migrations must stay backward compatible with the previous release for the duration of a rolling update.

## Built-in templates

The five built-in templates (`apps/api/builtin_templates/`) are part of the `api` image. The `migrate` Job runs `manage.py load_builtin_templates` right after `migrate` on every release, so a fresh database gets them and a changed built-in follows the release. It is idempotent and never changes user-uploaded templates. To reload by hand: `kubectl -n openprism exec deploy/api -- python manage.py load_builtin_templates`.

## Verified on the cluster

- **Read-only root filesystem for the TeX worker** (#113, 2026-11-11, `worker-compile` v0.1.5): the container runs with
  `readOnlyRootFilesystem: true`, non-root uid 1000, all capabilities dropped; writing to `/` or `/etc` fails ("Read-only
  file system") and `/tmp` (an `emptyDir`) is writable. A small document compiled to a PDF with `pdflatex`, `xelatex`,
  `lualatex`, `latexmk -norc -pdf` and tectonic (offline bundle), each with the compile environment (`HOME` in `/tmp`,
  shell escape off, `openout_any=p`, `openin_any=p` except lualatex). 25 MB of `/tmp` used. No chart change was needed.

## Unverified

The app is serving (`/api/health` through Caddy reports the deployed version; sign-in is required for the API). Not yet
checked on the cluster, in rough order of risk:

- **Live editing** (`/api/collab` websocket) through Caddy and the NodePort, large uploads (150 MB and above) and the
  arXiv-import event stream; see `deploy/caddy/README.md`. Needs a browser session against the live site.
- **Compile hardening inside the pod** (#113): the engines themselves are verified (below), but a hostile document that
  tries `\write18`, absolute-path reads and reading the worker's `/proc/*/environ` has not been run against the live pod.
  The same cases run in `jobs/tests.py` (`HostileDocumentTests`, `ScrubbedEnvironmentTests`) under `worker-tex`; run them
  with `docker compose run --rm worker-tex python manage.py test jobs --noinput`.
- **No NetworkPolicies** are installed: `worker-compile` has no network isolation (see the security model above).
- **The app uses the object store's root S3 key** unless `OPENPRISM_S3_ACCESS_KEY` / `_SECRET_KEY` exist (see the
  bootstrap section); to change it, delete `openprism-app-creds`, add the secrets, re-run the bootstrap workflow and redeploy.
- **Registration is by invitation** (`registration.mode`, default `invite`) and no SMTP credentials are set, so account mail, and so invitation links, may not be delivered: set up mail and make a superadmin before relying on it.
- A rolling update while a compile or transfer is running (the grace periods are set, the behaviour is not tested).
