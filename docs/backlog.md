# Backlog

## v0.0.1 - Templates

Both items moved to `docs/todo.md` (issues #8, #9).

## v0.0.1.1 - QA tooling

Moved to `docs/todo.md` (issue #10).

## v0.0.2 - Zotero

Moved to `docs/todo.md` (issues #12-#15).


## v0.0.3 - Workspace LLM Keys

Moved to `docs/todo.md` (issues #16-#19).

## v0.0.3.1 - Build fixes

Moved to `docs/todo.md` (issue #20).

## v0.0.4 - Version history with diff

Moved to `docs/todo.md` (issues #21-#26). Decided: only successful compiles are saved, unnamed versions keep the newest
50, named versions are kept forever, restore replaces the files and records a new version (blocked while an affected
file is open live). Left for later:

- [ ] **Visual PDF comparison** between two versions (page-by-page overlay or side by side with highlighted changes).
- [ ] **Save failed compiles as versions** ("what broke it"), shown with their log instead of a PDF.
- [ ] **Per-workspace storage accounting and a time-based retention option** for versions (blobs are deduplicated per
      project, so a workspace total needs its own query and a limit policy).
- [ ] **Restore a single file** from an old version.

## v0.0.5 - AI Assistance for LaTeX tasks

Moved to `docs/todo.md` (issues #27-#31). Design notes live in those issues.

## v0.0.5 follow-ups (found while building in-place AI editing)

- [ ] **Accepting a proposal writes other files by REST, even when someone has them open live** (known collaboration
      limitation). A multi-file proposal only goes through the shared document for the active file.
- [ ] **In-place AI undo in a live session** is the editor's own history; check that Ctrl+Z in a collaborative session undoes
      only the local user's accept (y-codemirror's undo manager) and does not undo remote edits.
- [ ] **No streaming.** The bar shows step names, not the model's text; long tasks look idle between steps.
- [ ] **Cite and bibliography tasks** ("cite the Attention paper") need the Zotero/arXiv tools in edit mode and a recorded task.
- [ ] **A configurable shortcut** (Ctrl/Cmd+K is fixed; browsers bind Ctrl+K to the address bar when the editor is not focused).
- [ ] **A cancelled request can still finish its current model call** (the worker checks between calls), and a cancel sent
      before the job row exists is lost.

## v0.0.6 - Better account management

Moved to `docs/todo.md` (issues #32-#39). Decided: SMTP via environment variables (Mailpit in development), existing accounts are
still added to a workspace at once (now with an email), pending invites need a verified address, and commenting is built
in this release.

## v0.0.7 - Misc


- [ ] **`tectonic` is offered as a compile engine but is not installed** in the worker image, so choosing it always
      fails with "tectonic not available". Install it or remove it from the engine list.
- [ ] **Failed template transfers leave their target project behind**, and a worker crash fails the job with no
      auto-resume (the user's API key is deliberately not stored, so resuming needs the user to start again).

## v0.0.8 - Security issues

- [ ] **No audit trail for stored credentials.** Workspace LLM keys and Zotero keys record only who last changed them.
      Keep an event log (who set, rotated or removed, when) visible to workspace admins, and consider per-workspace
      usage accounting and limits for LLM spend.
- [ ] **No limits on the expensive endpoints.** Only the auth endpoints are rate limited. Any registered user can run
      unlimited LLM, vision, plot and compile-heavy work, and with `OPENPRISM_LLM_API_KEY` set server-side that spends
      the operator's money. Add per-user rate limits and/or quotas, and decide whether the server-side key should be
      usable by everyone.
- [ ] **Credentials travel in URLs.** Images, PDFs, the arXiv import stream and the collaboration websocket authenticate
      with `?token=` (browsers cannot set headers there). nginx keeps query strings out of its logs and suppresses
      `Referer`, but other proxies/CDNs may log them. Option: short-lived, narrowly scoped URL tokens minted on demand.
- [ ] **Account tokens are in localStorage**, readable by any script that runs on the page (XSS). Option: httpOnly
      cookies, which means CSRF protection and a different websocket/blob auth story.
- [ ] **The plot sandbox is defence in depth, not a real sandbox** (AST check, builtin whitelist, scrubbed environment,
      non-dumpable worker, rlimits). LaTeX and plot code also share a user with the worker process, and LuaTeX can read
      any file that user can read. Run these workers under gVisor/Kata and cap pids (see the Kubernetes item).
- [ ] **LLM/MinerU keys the user enters are stored in the browser's localStorage** in plain text *(pre-existing)*.
- [ ] **Large uploads are buffered by the API** (up to 200 MB in memory). Presigned direct-to-S3 uploads would remove
      that memory pressure.
- [ ] **AI endpoints hold a web thread for up to 5 minutes** while they wait for the worker. Fine at small scale; move
      the clients to polling `/api/jobs/:id` before serving many users.

## v0.0.8 - Collaboration Enhancements

- [ ] **REST writes to a file someone has open are overwritten by the next live-editing save** *(pre-existing behaviour)*.
      Template apply/convert and uploads to an open file are the affected paths.
- [ ] **Renaming or deleting a file that has a live room can recreate it** at the old path on the next flush. The stored
      state is dropped, but the live room is not closed.
- [ ] **A hard server crash can lose up to ~800 ms of typing** (the flush debounce); awareness entries of a crashed
      replica linger until its clients reconnect.

## v0.0.9 - Better testing

- [ ] **Grow the browser test suite.** `apps/frontend/e2e` (Playwright, `npm run e2e`, against a running stack) now covers
      the editor shortcut and the PDF preview. Still to add: sign-in and registration, workspaces and invitations, invite
      links, two browsers editing live, and the file-panel actions. Then run it in CI.
- [ ] **Seven pre-existing TypeScript errors** (`EditorPage.tsx` ×6 and `latex/lang.ts`: CodeMirror/Blob/event-listener
      typings). `tsc --noEmit` should be clean so it can gate CI.
- [ ] **No CI.** Nothing runs the three test suites (API, TeX worker, AI worker), `tsc`, or a render of the Kubernetes
      overlays on push.
- [ ] **Split test-only dependencies.** `daphne` is in `requirements.txt` only because `channels.testing` imports it;
      the production API image does not need it (nor the test code).
- [ ] **`common.tests.VersionTests` rejects four-part versions** (`^\d+\.\d+\.\d+$`), so it fails while `apps/api/VERSION` is a
      patch release such as 0.0.3.1 (the project tags `vX.Y.Z.W` patches). Accept an optional fourth part. Found when
      the API suite ran on `main` after v0.0.3.1.
- [ ] **Random 401s ("Token is invalid") make the full test suites flaky.** Cause found: in the devcontainer (WSL2)
      the wall clock steps backwards by about a second several times a minute, so a token minted just before a step
      has an `iat` in the future and SimpleJWT rejects it. Different unrelated tests fail each run and pass alone;
      with `SIMPLE_JWT['LEEWAY'] = 5` the API suite (301) and worker-tex suite (130) pass every time. Add a small
      leeway under the test settings (not production) or fix the clock sync, and note it in CLAUDE.md.
- [ ] **`design/reference/` is untracked** (and `design/README.md` already links to it).

## v0.0.10 - Operations

- [ ] **No observability.** No metrics, structured logs, tracing or alerts; no view of queue depth, failed jobs, or
      websocket counts. (Queue depth is also the better autoscaling signal, see the KEDA component.)
- [ ] **No backup or restore story** for Postgres or the object store, and the local-cluster data stores are single
      instances.
- [ ] **Data-service defaults are placeholders.** Everything in `.env.sample` and `overlays/local` (passwords, storage
      keys, `DJANGO_SECRET_KEY`) is for development only; a real deployment needs generated secrets and a rotation plan.



## v0.1.0 Run the Kubernetes manifests on a real cluster

`deploy/k8s` has been rendered with `kubectl kustomize` and checked for internal consistency, but never applied to a
cluster. Do a full run on a local `kind` cluster, then fix whatever breaks.

**How**
1. `deploy/k8s/build-images.sh dev`
2. `deploy/k8s/kind/kind-up.sh` (creates the cluster with Calico, metrics-server and ingress-nginx, and loads the images)
3. `deploy/k8s/deploy.sh local`, then use the app at http://localhost:8088 and re-run the browser scenario (sign in,
   compile, invite link, two browsers editing live).

**Check, in rough order of risk** (the same list as "Unverified" in `deploy/k8s/README.md`)
- [ ] The Garage init Job (`overlays/local/garage-init-job.yaml`): it uses Garage's admin API (`/v1/layout`,
      `/v1/bucket`, `/v1/key/import`, ...) written from memory of the v1.0 API. Confirm each call, or switch to the CLI.
- [ ] Read-only root filesystem for the TeX worker: compile with `pdflatex`, `xelatex`, `lualatex` and `latexmk` inside
      a pod, and confirm the caches under `/tmp` work and the compile hardening still holds.
- [ ] NetworkPolicies on a real CNI: the default-deny policy must not break kubelet probes; `worker-compile` must have
      no internet; the workers that call LLM providers must reach only public HTTPS.
- [ ] HorizontalPodAutoscalers read CPU (needs metrics-server).
- [ ] `components/keda`: install KEDA and apply the component.
- [ ] Rolling update: change an image tag mid-job and confirm a running compile/transfer finishes rather than being killed.
- [ ] The `migrate` Job and the init containers that wait for it, including a second `deploy.sh` run (Job recreation).
- [ ] Production overlay placeholders (CIDRs, hostname, ingress-controller namespace label) against a real cluster.

**Decisions to make along the way**
- Whether `worker-compile` and `worker-ai` should run under a sandboxed runtime (`runtimeClassName: gvisor` or Kata).
- Whether to add PgBouncer in front of Postgres (connection count grows with API replicas).

