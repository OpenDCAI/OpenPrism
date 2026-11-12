# Deploying OpenPrism with Argo CD (v0.1.8)

Argo CD (v3.6, microk8s addon, namespace `argocd`) deploys the chart in `deploy/helm/openprism` from git. GitHub never
touches the cluster: a release tag builds the images and opens a **Deploy vX.Y.Z** pull request; **merging it is the
deploy**. Secrets stay in the GitHub repository secrets and reach the cluster as SealedSecrets (`deploy/argocd/secrets/`)
made by the **Seal secrets** workflow; only the controller in the cluster can decrypt them.

```
git tag vX.Y.Z ─► GitHub Actions: build + push images ─► PR "Deploy vX.Y.Z" (targetRevision) ─► merge ─► Argo CD sync
                                                                                                 │
GitHub secrets ─► "Seal secrets" workflow ─► PR with SealedSecrets (main) ─► merge ─────────────┘
Argo CD sync: wave -1 settings ─► Sync hook: migrate (+ built-in templates) ─► wave 1 Deployments ─► PostSync version check
```

| File | What |
|---|---|
| `project.yaml` | AppProjects: `openprism` (this repo, namespace `openprism` only, nothing cluster-scoped) and `openprism-platform` (Sealed Secrets) |
| `root.yaml` | app of apps: watches `apps/` on `main` |
| `apps/openprism.yaml` | the release: chart at the **tag**; the cluster's values (`valuesObject`, here) and `secrets/` from **main**; `secrets.revision` rolls the pods after a re-seal |
| `apps/sealed-secrets.yaml` | Sealed Secrets controller (pinned chart) |
| `secrets/` | SealedSecrets `openprism-core`, `openprism-ai` (if set), `ghcr-login-secret` |

`openprism-app-creds` (database password, S3 keys) is still made once by `deploy/bootstrap` and is not in git.

## Everyday

- **Release:** bump `apps/api/VERSION` on the release branch, merge to `main`, tag. Review and merge the Deploy PR. The
  "Wait for the Argo CD deploy" workflow goes green when `/api/health` reports the version.
- **Rotate a secret:** change the GitHub repository secret, run **Seal secrets** (Actions, give a reason), merge its PR.
  The pods roll because `secrets.revision` changed. The rest of the procedure is in `deploy/helm/README.md`, "Secrets".
- **A failed sync:** a failing migration stops the sync before any Deployment changes, so the running version keeps
  serving. The hook's pod and logs stay until the next sync: `kubectl -n openprism logs job/migrate`. Fix forward, or
  revert the Deploy PR (that is the rollback).
- **Look at it:** `kubectl -n argocd port-forward svc/argo-cd-argocd-server 8080:443` on the cluster host, then
  `ssh -L 8080:localhost:8080 ...` through the gateway; or `argocd app get openprism --core` on the host.

## Sealing key

Only the controller's private key can decrypt `secrets/`. Back it up once, right after the first install, into the owner's
password manager (never into git):

    kubectl -n kube-system get secret -l sealedsecrets.bitnami.com/sealed-secrets-key -o yaml > sealed-secrets-key.yaml

Losing it is not fatal: install the controller again, commit its new certificate and run **Seal secrets**, because GitHub
still holds every value.

## Cutover from the Helm workflow (#172), one window, owner on the cluster host

The cutover changes **how** the cluster is deployed, not **what** runs: Argo adopts the running v0.1.7.1, and v0.1.8 is
then the first release through a Deploy PR. Until then `apps/openprism.yaml` points at commit `c63a757` (the v0.1.8
chart while its appVersion was still 0.1.7.1, so the images are v0.1.7.1's), not at a tag.

Before: v0.1.7.1 is live through the old workflow; `release/v0.1.8` (VERSION 0.1.8) is merged to `main` **without a tag**
(merging does not deploy), so `root.yaml` finds `deploy/argocd/apps/`. The values in `apps/openprism.yaml` were checked on 2026-11-12:
`helm get manifest openprism` and `helm template` with them differ only in sync waves, the pods' checksum annotations,
and the migrate and PostSync Jobs (Secrets left out of the comparison).

1. **Projects and controller:** `kubectl apply -f deploy/argocd/project.yaml -f deploy/argocd/root.yaml`. The root app
   creates `sealed-secrets` (and `openprism`, which has no automated sync yet). Wait for the controller, back up its key
   (above), and commit its certificate as `deploy/sealed-secrets/cent-cert.pem` (`deploy/sealed-secrets/README.md`).
2. **Seal:** run **Seal secrets**, review and merge its PR.
3. **Let the controller adopt the Secrets Helm made** (same names, so no gap):
   `for s in openprism-core openprism-ai ghcr-login-secret; do kubectl -n openprism annotate secret $s sealedsecrets.bitnami.com/managed=true --overwrite; done`
   The controller overwrites their contents with the sealed values; they should be identical.
4. **Diff:** `argocd app diff openprism --core` (or the UI). Expected: labels and annotations (sync waves, the
   `argocd.argoproj.io/instance` label), the migrate Job under its new name, the PostSync Job. Anything else: stop.
5. **Sync once by hand:** `argocd app sync openprism --core`. Migrations run (nothing to do), then the pods roll once.
   Check `/api/health` (still 0.1.7.1), sign in, compile, an AI request, an export.
6. **Retire Helm's records** (not the resources): `kubectl -n openprism delete secret -l owner=helm,name=openprism`.
   **Never `helm uninstall`**: it would delete the running app.
7. **Switch on:** set `syncPolicy.automated: {prune: false, selfHeal: true}` in `apps/openprism.yaml` (PR), and the
   repository variable `DEPLOY_WITH_ARGOCD=true` (Settings → Secrets and variables → Actions → Variables). From now on a
   tag opens a Deploy PR and the Helm job is skipped.
8. **First release through Argo:** tag `v0.1.8` on `main`. The workflow builds the images and opens **Deploy v0.1.8**
   (the commit becomes the tag); merge it. Argo syncs, the PostSync check passes, and *Wait for the Argo CD deploy* goes
   green when `/api/health` reports 0.1.8.

**Rollback during the window:** `argocd app delete openprism --cascade=false --core` (keeps every resource), then
redeploy the previous tag with the old workflow (Actions → "Release - build images & deploy", `tag`, `build` off).

## After the cutover (backlog #174)

Build images on GitHub-hosted runners, then delete `KUBECONFIG_CENT_BASE64` and the self-hosted runner.
