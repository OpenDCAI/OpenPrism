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

- [ ] **A hotkey to ask the AI to do a task in place** ("add an author", "create a new section on related work", "turn
      this list into a table"). Press a shortcut anywhere in the editor, type the request in a small command bar, and
      get a reviewable change, without leaving the text for the Assistant panel. Notes for whoever picks it up:
      - *Most of the machinery exists.* The agent's tools mode already reads files, lists files and proposes patches,
        and the editor already shows proposed patches for accept/reject. The new work is the entry point and the
        context it sends: active file, cursor position, selection, and the project's main file.
      - *Never apply silently.* Show the result as a diff to accept or reject (the existing patch UI), and make accepting
        one undoable step. In a collaborative session an accepted change must be applied through the live document (the
        editor's `writeFileCompat` path already does this); a stale proposal (the file changed meanwhile) should be
        rebased or rejected rather than overwrite other people's edits.
      - *Tasks touch more than the cursor.* An author goes in the title block, and the right markup differs per
        template (ACL, NeurIPS and CVPR each do it differently); a new section may also add a file and an `\input`.
        Give the agent the template identity and let it read the preamble, and expect multi-file patches.
      - *Shortcut conflicts.* Already taken: Alt+/ and Ctrl/Cmd+Space (inline completion), Ctrl/Cmd+/ (comment),
        Ctrl/Cmd+F, Ctrl+S, Ctrl+Enter (compile), Ctrl+B and Ctrl+Alt+B (panels). Pick one that works on Mac, Windows
        and Linux and with IME input, make it configurable, and also reach it from the editor menu and a toolbar button
        so it is discoverable and keyboard-accessible.
      - *Latency and cost.* The AI endpoints currently block for the whole run. Show progress, allow cancel, and apply
        the AI rate limits/quotas and per-workspace key work listed elsewhere in this file.
      - *Who can use it:* members who can edit; not viewers, commenters or invite-link guests.
      - Keep recent requests so a user can repeat one, and test the prompts against a few real templates with the fake-LLM
        harness plus a small set of recorded tasks.

## v0.0.6 - Better account management

- [ ] **Account management is minimal.** No password reset, email verification, change-password screen, or
      account deletion. Registration is open to anyone who can reach the site (consider invite-only or verification).
- [ ] **Workspace invitations send no email.** Invited addresses wait until that person registers; the inviter has to
      tell them. Needs an email provider and a template (and probably an accept/decline step).
- [ ] **The Commenter role does nothing yet.** It exists in the UI and API (read-only) but there is no commenting feature.
- [ ] **Project invite links are always "editor".** The API supports `viewer` links; the Collaboration panel only offers
      editor. Add a role choice (and a way to see/revoke outstanding links).


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
- [ ] **Intermittent failures in the full API suite**, a different test each run and always green when run alone
      (seen: `integrations ConnectionTests.test_users_are_isolated_and_login_is_required` with a missing `connected`
      key, and `transfer TransferApiTests.test_legacy_transfer_with_compile_fix`). Find the shared state (rate
      limits, cache, Redis, the live dev workers sharing the broker) before it hides a real failure.
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

