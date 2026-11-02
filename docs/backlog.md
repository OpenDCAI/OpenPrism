# Backlog

## v0.0.1 - Templates

- [ ] **Template transfer: the layout check cannot finish from the UI** *(pre-existing)*. The backend supports the whole
      pause/resume flow, but `TransferPanel` stops at `waiting_images` and nothing renders the compiled PDF's pages or
      calls `transferSubmitImages`, so a job with "layout check" enabled waits forever. Needs a PDF-page capture step
      in the browser (pdf.js is already a dependency).
- [ ] **Two built-in templates compile to nothing.** The ACL manifest entry says `main.tex`, but its files are
      `acl_latex.tex` / `acl_lualatex.tex`. The arXiv template is not in `templates/manifest.json`, and the importer
      defaults its main file to `main.tex` although the file is `template.tex`. A new project from either has no file to
      compile (cvpr, neurips and icml are fine). Fix the manifest/importer, then check the editor opens the right file.

## v0.0.2 - Zotero

- [ ] **Zotero connector.** Let a user link their Zotero library (and group libraries) and use it from a project: browse or
      search references, insert `\cite{}` keys at the cursor, and keep a project `.bib` file in sync. It would sit
      beside the existing arXiv search/BibTeX tools in the editor. Notes for whoever picks it up:
      - Zotero's Web API (v3, `api.zotero.org`) can return items as BibTeX/BibLaTeX and supports incremental sync with
        a library version number; it asks clients to honour `Backoff` / `Retry-After`. Check current limits first.
      - *Credentials are the main design decision.* A Zotero API key (or OAuth token) is a long-lived per-user secret,
        and the app currently stores no user secrets (LLM keys live only in Redis for a job's duration). Either keep it in
        the browser like the LLM key, or store it server-side encrypted, which needs key management and a deletion/rotation
        path. Sync from a Celery task (not the request) needs the secret available there.
      - Citation keys must be stable and unique across a library; decide between Zotero's own keys, Better BibTeX keys,
        or generating them, and what happens when a key changes after it has been cited.
      - Generated `.bib` content should be treated as managed: decide whether users may edit it, and how a re-sync
        handles local edits (it will collide with collaborative editing of the same file).
      - The API host is fixed, so the SSRF guard that protects user-supplied URLs is not needed, but responses are
        untrusted input (BibTeX is fed to LaTeX/bibtex, which run in the hardened compile worker).
      - Tests can follow the existing pattern: a fake HTTP server standing in for Zotero.


## v0.0.3 - Workspace LLM Keys

- [ ] **LLM keys per workspace.** Let a workspace owner or admin configure the LLM provider for the whole workspace
      (endpoint, model, API key) so members use it without pasting their own key, and so a team's AI spend is billed to
      the team. Today a key is either typed into each browser (kept in localStorage, sent with every request) or is the
      single server-wide default. Notes for whoever picks it up:
      - *Storage is the main decision.* The current rule is that user keys are never persisted (they live in Redis for a
        job's duration). A workspace key must be stored, so it needs encryption at rest with a key held outside the
        database (KMS or a sealed secret), masking in the UI and API (show the last four characters, never return the
        key), and a way to rotate and delete it. The Zotero connector has the same decision; solve them together.
      - Resolution order for a request: the workspace key (if the project's workspace has one), else the user's own
        browser key, else the server default. Decide whether a workspace key can be made mandatory (no personal keys).
      - Who may use it: probably any member who can edit, not commenters or viewers; invite-link guests should not (they
        cannot use AI features today). Who may set it: owners and admins only.
      - The worker must receive the key without it entering Postgres rows, logs or Celery results: reuse the per-job
        Redis secret hand-off (`common/secrets.py`), looked up by the API when it queues the job.
      - Per-workspace endpoint/model settings go through the same SSRF guard as user-supplied URLs.
      - Pairs naturally with usage accounting and limits per workspace (see the rate-limit item under Security and abuse),
        and with an audit trail of who changed the key.

## v0.0.4 - Version history with diff

- [ ] **Version history: a saved version per compile, and a diff to compare versions.** Every compile records what was
      compiled, so a user can see how the paper changed between two PDFs, open an old version, and restore it. Notes for
      whoever picks it up:
      - *What a version is:* a manifest of the project's files at compile time (path, kind, and a content hash or blob
        reference), plus the engine, main file and the resulting PDF. Today a compile materialises the files into a temp
        directory and keeps nothing; the PDF is deleted with its job after 24 hours (`jobs.tasks.cleanup_old_jobs`), so
        versions need their own retention.
      - *Storage:* text files live in Postgres and binaries in object storage under random keys, so a naive full copy per
        compile grows fast. Prefer content-addressed blobs (store each distinct file once, versions just point at them),
        skip a version when nothing changed since the last one, and decide a retention policy (keep the last N, keep
        pinned/named versions forever, expire the rest) and per-workspace storage accounting.
      - *Consistency:* the snapshot must match what was compiled, including edits still in a live collaborative room.
        The compile endpoint reads the database, so flush the room first (`POST .../collab/flush` already waits for every
        replica) and snapshot from that same read.
      - *Which compiles:* decide whether failed compiles are saved (useful for "what broke it"), and whether the
        transfer pipeline's internal compiles create versions (probably not).
      - *Diff:* per-file text diffs between any two versions (the editor already renders diffs for AI patches, so reuse
        that component); show added/removed/changed files, and binaries as changed-or-not. Optionally a visual PDF
        comparison later.
      - *Restore:* writing an old version back must go through the collaboration layer, because a REST write to an open
        file is overwritten by the next live save (see the Collaboration section); restoring while others are editing
        needs a clear rule. Restore should itself create a new version rather than rewrite history.
      - *Permissions:* any member (and invite guests) can view and diff; restoring or deleting a version needs write
        access. Allow naming/pinning a version ("submitted to ACL").
      - Don't confuse this with the Yjs document history, which is not kept and is not a user-facing version log.

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

