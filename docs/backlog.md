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
file is open live). 

## v0.0.4.1 - Version history with diff Follow up

Moved to `docs/todo.md` (issues #42-#46). Decided: a single-file restore records no version; failed compiles are kept
with their log (newest 10 unnamed, separately from the 50 successful); storage is a report, not a quota, and time-based
retention is an optional per-workspace setting that always keeps each project's newest version; PDF comparison is done
in the browser by pixel diff.

## v0.0.5 - AI Assistance for LaTeX tasks

Moved to `docs/todo.md` (issues #27-#31). Design notes live in those issues.


## v0.0.6 - Better account management

Moved to `docs/todo.md` (issues #32-#39). Decided: SMTP via environment variables (Mailpit in development), existing accounts are
still added to a workspace at once (now with an email), pending invites need a verified address, and commenting is built
in this release.


## v0.0.7 - Misc

Moved to `docs/todo.md` (issues #40, #41). Decided: install tectonic with an offline bundle (the compile worker has
no internet in Kubernetes); delete a failed transfer's unfinished target project automatically.

## v0.0.8 - Security issues

Moved to `docs/todo.md` (issues #47-#53). Decided: AI clients poll jobs; per-user rate limits, a policy
(`SERVER_LLM_KEY_USERS`) and a daily quota for the server-side key, and per-workspace daily limits (requests, not
tokens); an append-only credential event log; users' own AI keys stored encrypted on the server (changing an endpoint
needs the key again); short-lived scoped URL tokens are the only `?token=` credential; the refresh token in an httpOnly
cookie and the access token in memory; presigned direct uploads for binary project files. The gVisor/Kata item moved to
v0.1.0.

## v0.0.8 follow-ups (found while building it)

- [ ] **The arXiv import stream holds a web thread for up to 16 minutes** (`import_arxiv_sse` relays the job's progress
      over SSE). Move it to the same job polling as the AI endpoints.
- [ ] **Template ZIP upload and project ZIP import still pass through the API** (direct uploads cover project files
      only).
- [ ] **The client's refresh retry after 1.5 s (`api/auth.ts`) was for the dev clock steps**, which `JWT_LEEWAY_SECONDS`
      (#57) now absorbs in the compose stack. Remove the retry once browser runs show it is never taken.
- [ ] **The dev api's hot reload can hang** ("Waiting for connections to close") while a browser holds an SSE stream or
      websocket open; `docker compose up -d --force-recreate api` recovers. Consider `--timeout-graceful-shutdown`.
- [ ] **AI usage counts requests, not tokens.** Record the providers' reported `usage` per job for spend accounting.

## v0.0.9 - Collaboration Enhancements

Moved to `docs/todo.md` (issues #54-#56). Decided: REST text writes go through the Yjs state (no more overwrites);
rooms are tied to their stored document, so rename follows the file and delete closes the room; edits are logged in
Redis until flushed, and awareness entries expire.


## v0.0.10 - Better testing

Moved to `docs/todo.md` (issues #57-#62). Decided: a `JWT_LEEWAY_SECONDS` setting (0 in production, 5 s in tests and the
compose dev stack) for the devcontainer's clock steps; CI on GitHub Actions runs typecheck, the k8s render and the API and
AI-worker suites on every push, and adds the TeX-worker and browser suites on `main` and `release/*`.

## v0.0.10.1 - Live-editing names

Moved to `docs/todo.md` (issue #63). Decided: accounts default to their account name; a typed name is kept per account.

## v0.0.11 - Operations

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

- [ ] **The plot sandbox is defence in depth, not a real sandbox** (moved from v0.0.8): AST check, builtin whitelist,
      scrubbed environment, non-dumpable worker, rlimits. LaTeX and plot code also share a user with the worker process,
      and LuaTeX can read any file that user can read. Run these workers under gVisor/Kata and cap pids.

**Decisions to make along the way**
- Whether `worker-compile` and `worker-ai` should run under a sandboxed runtime (`runtimeClassName: gvisor` or Kata).
- Whether to add PgBouncer in front of Postgres (connection count grows with API replicas).


## v0.1.1 follow-ups (found while building in-place AI editing)

- [ ] **Accepting a proposal writes other files by REST, even when someone has them open live** (known collaboration
      limitation). A multi-file proposal only goes through the shared document for the active file.
- [ ] **In-place AI undo in a live session** is the editor's own history; check that Ctrl+Z in a collaborative session undoes
      only the local user's accept (y-codemirror's undo manager) and does not undo remote edits.
- [ ] **No streaming.** The bar shows step names, not the model's text; long tasks look idle between steps.
- [ ] **Cite and bibliography tasks** ("cite the Attention paper") need the Zotero/arXiv tools in edit mode and a recorded task.
- [ ] **A configurable shortcut** (Ctrl/Cmd+K is fixed; browsers bind Ctrl+K to the address bar when the editor is not focused).
- [ ] **A cancelled request can still finish its current model call** (the worker checks between calls), and a cancel sent
      before the job row exists is lost.


## v0.1.2 follow-ups (found while building account management and comments)

- [ ] **No way to change the account's email address** (it would need re-verification and must not orphan invitations).
- [ ] **Comment notifications.** Nobody is told about a new comment or reply (mail digest, @mentions, an unread count).
- [ ] **Comment gutter markers** were left out; highlights only. Long files need a way to see where comments are.
- [ ] **Permanently deleting a project leaves its compile jobs' storage** (`jobs/<id>/` prefixes) until the job rows age
      out; account deletion inherits this. Delete the prefixes with the project.
- [ ] **Comments on live text are placed against the stored file on the server**, which can lag the live document by
      ~800 ms; the editor re-places them against its live text, but the API's `anchor` may briefly disagree.
- [ ] **Two owners can no longer demote each other** (owners are fixed once made); decide whether an owner may step down.

## v0.1.3 follow-ups (security follow ups)

- [ ] **The plot sandbox is defence in depth, not a real sandbox** (AST check, builtin whitelist, scrubbed environment,
      non-dumpable worker, rlimits). LaTeX and plot code also share a user with the worker process, and LuaTeX can read
      any file that user can read. Run these workers under gVisor/Kata and cap pids (see the Kubernetes item)

## v0.1.4 follow-ups (found while building it)

- [ ] **Zotero's `applied: false` hand-back and version restore's 409 for open files predate #54.** Now that REST text
      writes reach open rooms, the Zotero add could always write, and restore could write text files behind live rooms
      (binary/removed files still need thought). Simplify both and their editor code.

## v0.1.5 follow-ups (found while building it)

- [ ] **New model fields have no database default, so old code breaks during a rollout.** `ProjectVersion.status`,
      `log_key` and `log_size` (and any later field) use Django defaults, which the old code does not send: between the
      migration and the worker restart, every version insert failed (the compile still succeeded, the version was lost).
      Use `db_default` for new non-null fields, and document "restart workers after migrating" for compose.
- [ ] **The PDF comparison's highlight paints both versions' ink** where a word changed, so the changed text is hard to
      read in Highlight mode; consider tinting only the after page's pixels and outlining removed areas.
- [ ] **The Compare dialog closes at phone width when the editor collapses its right panel** (it lives inside the
      Versions panel). Opening it at phone width works.
