# Completed features and their release

## v0.0.1 - Templates

- [x] #8 **Built-in ACL and arXiv templates (and uploaded templates) have no compilable main file.** ACL's manifest
      says `main.tex` but its files are `acl_latex.tex` / `acl_lualatex.tex`; arXiv is not in the manifest and its file
      is `template.tex`; template upload also hard-codes `main.tex`. Detect the main file; fix the manifest.
- [x] #9 **Template transfer: the layout check cannot finish from the UI.** The backend pauses at `waiting_images`;
      `TransferPanel` must render the compiled PDF's pages (pdf.js), call `transferSubmitImages`, and resume polling.
      The backend must also serve the PDF during the pause.

## v0.0.1.1 - QA tooling

- [x] #10 **Playwright, Chromium and Chrome in the devcontainer.** Bake Playwright (pinned to the repo's version),
      Chromium and Google Chrome stable into `.devcontainer/Dockerfile`; add a root `e2e` script; `E2E_BROWSER=chrome`
      selects Chrome; update the docs; make it work in the running container too.
- [x] #11 **API tests delete the built-in templates' files from the dev bucket.** `BuiltinTemplateTests` (from #8)
      imports the real templates and the shared cleanup clears their storage. Keep the real templates' files; add a guard.

## v0.0.2 - Zotero

- [x] #12 **Encrypted per-user key store and connect/disconnect API.** `CREDENTIAL_ENCRYPTION_KEY` (rotatable Fernet),
      `integrations.ZoteroConnection`, `PUT/GET/DELETE /api/integrations/zotero`; the key is never returned or logged.
- [x] #13 **Zotero client and browse API.** Libraries (personal + groups), collections, paged item search; honours
      `Backoff`/`Retry-After`; library allow-list.
- [x] #14 **BibTeX export and append-only add to the project `.bib`.** Skips entries already added, generated-key
      fallback, sanitises untrusted BibTeX, flushes live collab rooms first (and leaves the write to the editor when
      the file is open live).
- [x] #15 **Editor panel to search and insert citations.** Connect screen, Zotero panel, `\cite{}` insertion,
      Playwright spec against a fake Zotero (`integrations.devserver`).

## v0.0.3 - Workspace LLM Keys

- [x] #16 **Encrypted storage and management API.** `WorkspaceLlmConfig`, `GET/PUT/DELETE /api/workspaces/:id/llm`,
      masking, SSRF check on the endpoint.
- [x] #17 **Use it for the AI endpoints and template transfer.** Workspace provider first (write roles), then the
      browser's key, then the server default; `/api/llm` takes `projectId`; the key only travels as a task argument /
      Redis job secret.
- [x] #18 **Admin settings in the workspace.** AI provider block under Settings: configure, rotate, remove; other
      members see a read-only status.
- [x] #19 **Editor notice and `projectId` for `/api/llm`.**


## v0.0.3.1 - Build fixes

- [x] #20 **Web image build.** `.dockerignore` hid `apps/api/VERSION`, so `docker compose build web` failed; the file is
      now let through (nothing else from `apps/api` enters the context).

## v0.0.4 - Version history with diff

- [x] #21 **Snapshot every successful compile.** `versions` app: `ProjectVersion` (manifest + PDF) and per-project
      content-addressed `VersionBlob`s; the snapshot is taken from the same read the compiler used, unchanged
      projects create no new version, a failed snapshot never fails the compile, project delete removes it all.
- [x] #22 **Read API.** List (paged), detail with manifest, PDF and file of a version, and a manifest diff between two
      versions or against the current project; read access for any member and invite guests; typed functions in
      `client.ts`.
- [x] #23 **Name/pin, delete and retention.** `PATCH`/`DELETE` on a version (write access; named versions must be
      unnamed before deleting), shared blob cleanup, and the daily `versions.tasks.prune_versions` that keeps the newest
      50 unnamed versions per project (`VERSION_KEEP_UNNAMED`).
- [x] #24 **Restore API.** `POST …/versions/:vid/restore` makes the files exactly the version's through one atomic
      `files.apply_changes`, records a new version, and answers 409 (nothing written) while someone is connected to an
      affected file; idle rooms are evicted first (new `KIND_EVICT` collab control message).
- [x] #25 **Editor panel.** Versions rail tool: list, open an older PDF (labelled, with a way back), name/unname and
      delete; viewers see no controls; "Saved as version #N" after a compile; `e2e/versions.spec.ts`.
- [x] #26 **Compare and restore in the UI.** Compare dialog (any two versions or the current project, split line
      diff, swap), restore with a confirmation that lists what changes, a 409 explanation when someone has a file open,
      and a shared `SplitDiff` component; Playwright specs incl. a second live browser.

## v0.0.4.1 - Version history with diff Follow up

- [x] #42 **Restore a single file** from an old version (API + Compare dialog). No new version is recorded.
- [x] #43 **Save failed compiles as versions**, with their log; newest 10 unnamed failed versions kept separately.
- [x] #44 **Versions panel shows failed versions** (Failed badge, Open log).
- [x] #45 **Workspace storage report and time-based retention** (optional per-workspace days; newest version always kept).
- [x] #46 **Visual PDF comparison** between two versions (side by side and highlighted pixel differences).

## v0.0.5 - AI assistance for LaTeX tasks

- [x] #27 **Give the agent editor context.** `editContext` (active file, caret, selection, main file, unsaved text) on
      `POST /api/agent/run`: validated, write access only, caret-marked prompt with the main file's `\documentclass`, and
      a system prompt telling the model to read the preamble because front matter differs per template. New
      `replace_text` tool (exact, unique old text) and cumulative staging, so several edits to one file are one patch and
      edit mode refuses full rewrites of existing files (a live run first produced stray whitespace changes that way).
- [x] #28 **Command bar opened by a hotkey.** Ctrl/Cmd+K (also the toolbar "Ask AI" button and Insert menu), Esc closes
      and returns to the editor, hidden for viewers and guests (the tree endpoint reports `canWrite`).
- [x] #29 **Review, accept (one undo step), reject, stale handling.** Proposals open in the Diff preview; accepting is a
      single editor transaction (a live room carries it through the shared document); a changed file is merged by a
      line-level three-way merge when the edits do not overlap, otherwise the proposal is marked stale and nothing is
      written. Two-browser Playwright test included.
- [x] #30 **Progress, cancel, rate limit, recent requests.** The agent logs progress the bar shows; Cancel stops the
      worker before its next model call and drops a late answer; `AI_EDIT_RATE_PER_MINUTE` (20) per user returns 429;
      Up/Down recalls the last 20 requests. Found and fixed on the way: the bar lost focus after a request.
- [x] #31 **Recorded-task tests across templates, docs.** `ai/test_edit_tasks.py`: add an author, add a related work
      section, list-to-table on ACL, NeurIPS, ICML and CVPR with a replayed model, prompt and patch checks, and a real
      compile of the edited project in `worker-tex`. Also run against the real model from `.env` (gpt-6-luna): author and
      related-work on all four templates, 8 of 8 gave small diffs (4 to 15 changed lines) that compile, 5 to 12 s each.

## v0.0.6 - Better account management

- [x] #32 **Email delivery.** SMTP from `EMAIL_*`/`APP_BASE_URL` (required outside debug), Mailpit in compose (:8025),
      templated text+HTML mail sent by a retried Celery task that never logs bodies, `send_test_email`, k8s config and an
      SMTP-only egress policy for `worker-ai`.
- [x] #33 **Password reset and change.** Reset link by mail (same answer for unknown addresses, single use, 1 h), change
      password on the new Account settings page; any change revokes every refresh token and mails a notice. The sign-in
      form no longer flags empty fields on blur (it shifted the form under the pointer).
- [x] #34 **Delete account.** Password required; personal and solo team workspaces go with their projects and storage;
      refused (with the list) while the user alone owns a shared workspace. New: owners can make a member an owner.
      Dialogs are now named by their title.
- [x] #35 **Email verification and registration modes.** Signed 3-day link; pending workspace invitations are accepted
      only once the address is verified (registering alone used to be enough); optional `REQUIRE_EMAIL_VERIFICATION`
      gate (API, websocket, UI) and `REGISTRATION_MODE=invite`. Existing accounts are marked verified.
- [x] #36 **Invitation mail.** Sign-up link with the address filled in for new addresses, an "added you" mail for
      existing accounts, sent time / "Email not sent" / Resend (10 min) in Members; workspaces reload on verification.
- [x] #37 **Invite-link roles.** Edit / comment / view links with a lifetime, list and revoke; revoking closes that link's
      live connections on every replica (per-project collab channel). Read-only editor for people who cannot write.
- [x] #38 **Comments API.** Threads anchored by quote + context (orphaned, not lost, when the text goes), replies,
      resolve/reopen, own edit/delete; commenters and editor/commenter links comment, viewers read; threads follow renames.
- [x] #39 **Comments in the editor.** Comment button / Ctrl+Alt+M, highlights that follow edits and open their thread,
      Comments tool (file or project, resolved collapsed, orphaned listed) refreshed every 15 s.

## v0.0.7 - Misc

- [x] #40 **Tectonic engine.** `worker-tex` carries tectonic 0.17.0 and its TeX Live 2022 bundle unpacked to a directory
      (pinned SHA-256s, own Dockerfile stage, prebuilt read-only format cache; about 3 GB), run with `--untrusted
      --bundle <dir>`, so it never downloads. All built-in templates compile with `--network none`. A package missing
      from the bundle names itself in the job error. Found on the way: a document's `.run.xml` makes tectonic run biber
      with arguments it chooses, so biber is kept off tectonic's PATH (biblatex documents are told to use another
      engine); tectonic records absolute paths in SyncTeX, so caret-to-PDF lookups use them.
- [x] #41 **Failed transfers clean up.** A failed template transfer (error, compile give-up, timeout, dead worker, or a
      layout check left unanswered for an hour) deletes its unfinished target project; the job keeps its error and the
      panel says the project was removed.

## v0.0.8 - Security issues

- [x] #47 **AI clients poll the job.** The AI endpoints answer `{jobId}` at once with `async: true` and the frontend polls
      `/api/jobs/:id` through one helper (`runAiJob`), so no AI request holds a web thread; blocking stays, deprecated,
      for old clients.
- [x] #48 **Limits on expensive work.** Per-user rate limits on AI endpoints and compiles; the server's AI key has a
      policy (`SERVER_LLM_KEY_USERS`) and a per-user daily quota; workspace providers can have a daily limit; jobs are
      counted per day by the key that paid (admins see today and 30 days). Found and fixed: a request naming its own
      endpoint without a key had the operator's LLM key (and MinerU token) sent to that endpoint.
- [x] #49 **Credential audit log.** Who set, replaced, changed or removed a workspace AI provider or a Zotero key, and
      when; shown as Key history to workspace admins and, for one's own keys, on the Account page.
- [x] #50 **Users' AI keys on the server.** LLM, search, vision and MinerU keys are saved encrypted on the server
      (last four shown, never returned; a new endpoint needs the key again) instead of in plain-text localStorage;
      requests name a profile; keys left by older builds move to the server once and leave the browser.
- [x] #51 **Scoped URL tokens.** `?token=` takes only an hour-long token for one project (or the arXiv import),
      minted on demand and re-checked on every use; account and invite tokens no longer appear in any URL (invite
      links are resolved by POST).
- [x] #52 **Session cookie.** The refresh token is an httpOnly, SameSite=Strict cookie (refresh and logout need a
      custom header and a trusted Origin) and the access token lives in memory; tabs take turns refreshing and share
      tokens and sign-outs; older builds' stored tokens move into the cookie once.
- [x] #53 **Direct uploads.** Binary project files go from the browser straight to object storage with presigned
      PUT URLs (size checked before they join the project; abandoned uploads cleaned up); text files still go through
      the API. Bucket CORS is set by `garage-init.sh`.

## v0.0.9 - Collaboration Enhancements

- [x] #54 **REST writes to a file someone has open are overwritten by the next live-editing save.** Every text write
      becomes a CRDT edit of the file's stored Yjs state and is published to the live room.
- [x] #55 **Renaming or deleting a file that has a live room can recreate it.** Rooms track their stored document; a
      rename moves it, a delete makes the room close (code 4404) without writing, and the editor follows.
- [x] #56 **A hard server crash can lose up to ~800 ms of typing; a crashed replica's cursors linger.** A per-replica
      Redis update log replayed on load and by a beat task; awareness entries expire after 30 s.

## v0.0.10 - Better testing

- [x] #57 **Random 401s from the devcontainer's clock steps.** `JWT_LEEWAY_SECONDS`: 5 s under tests and in compose,
      0 (unset) in production and Kubernetes.
- [x] #58 **`tsc --noEmit` reported 6 errors.** Now clean (`npm run typecheck`), without casts or ignores; the ghost-text
      field read a property that never existed.
- [x] #59 **Test-only dependencies in the production API image.** `daphne` moved to `requirements-dev.txt` (compose
      builds a `dev` stage); production images carry no test modules.
- [x] #60 **Browser specs:** registration and sign-in through the forms (including the `next` link), workspaces and
      members, two people typing at once, and file rename/delete/move.
- [x] #61 **CI** on GitHub Actions: typecheck, the k8s render and the API and AI-worker suites on every push; the TeX
      worker and the full browser suite (web image on :8080) on `main` and `release/*`.
- [x] #62 **`design/reference/` untracked.** It was already tracked; it is now kept out of the web build context.

## v0.0.10.1 - Live-editing names

- [x] #63 **Live-editing carets show the account's name, not "Guest".** A signed-in person's caret label defaults to
      their account name; a name typed in the editor is kept per account (`openprism-collab-name:<userId>`) and only
      when typed. Invite guests keep the shared `openprism-collab-name` key and the "Guest" default.

## v0.1.0 - Deploy to the cent Kubernetes cluster

- [x] #64 **Bootstrap of the hosted Postgres and storage.** `deploy/bootstrap`: a short-lived Job creates role and
      database `openprism` (generated password) and the bucket; the credentials live only in the cluster Secret
      `openprism-app-creds`; the root Postgres credentials are loaded only while that Secret is missing. Run on the
      cluster via the manual "Bootstrap hosted services" workflow.
- [x] #65 **Helm chart `deploy/helm/openprism`** replaces the kustomize tree: api, web (NodePort 31081), three workers,
      beat and a per-revision migrate Job against the cluster's hosted Postgres, Redis and MinIO. Installed (revision 1)
      and upgraded (revision 2) on the cluster.
- [x] #66 **Release workflow** `.github/workflows/deploy-cent-k8s.yaml` on the self-hosted runner: a `vX.Y.Z` tag
      (equal to `apps/api/VERSION`) builds four images, deploys, checks every rollout and smoke-tests the public URL;
      `workflow_dispatch` can redeploy an existing tag without rebuilding. v0.1.0.4 went through it green.
- [x] #67 **Caddy2 reference configuration** `deploy/caddy/openprism.Caddyfile` and README (hostname, node addresses,
      NodePort 31081; 200 MB bodies, unbuffered streaming, hour-long timeouts, `?token=` removed from the log). Validated and
      exercised against a real Caddy with a stand-in upstream (limit, log filter, header replacement, SSE flushing,
      failover). The site is served through Caddy; the checks that need the live site are deferred (see the backlog).
- [x] #68 **CI checks the deployment; the kustomize tree is gone.** The `deploy-checks` job lints and renders the Helm
      chart (asserting the NodePort, the fixed `api` Service name, no Ingress or data services, no root credentials,
      required inputs enforced), validates the Caddy config and runs ShellCheck on the deploy scripts. `deploy/k8s`
      (kustomize, kind, ingress-nginx, KEDA) is removed; its security model and unverified list moved to
      `deploy/helm/README.md`. CI green on `release/v0.1.0` (run on commit 50f6485).

## v0.1.0.1 - v0.1.0 follow-up fixes

- [x] #69 **Image builds exhausted the shared runner's disk.** Images build one at a time, each is removed after
      pushing (only this release's tag and dangling layers), and the first step fails early with the free space.

## v0.1.0.2 - v0.1.0.1 follow-up fixes

- [x] #70 **The bootstrap failed silently.** On failure it prints the Job and pod status, events and container logs
      before cleaning up, gives up early when no pod is created or an image cannot be pulled, and can be run alone
      from the "Bootstrap hosted services" workflow.

## v0.1.0.3 - v0.1.0.2 follow-up fixes

- [x] #71 **The MinIO client image could not be pulled** (MinIO no longer distributes `mc`; `minio/mc` is archived).
      The bucket is created with a plain S3 client (`deploy/bootstrap/s3-init.py`, boto3 in the release's `api` image).
      Consequence recorded in the docs: the S3 API cannot create keys, so the app uses the key pair it is given
      (`OPENPRISM_S3_*` if set, otherwise the store's root key).

## v0.1.0.4 - v0.1.0.3 follow-up fixes

- [x] #72 **A leftover temporary Secret blocked every later bootstrap.** The script now clears them first.
- [x] #73 **A failed Helm install left no evidence.** `deploy/diagnose.sh` prints pods, events, node capacity and
      container logs before the workflow rolls back itself (`helm rollback`, or uninstall on a first install); an
      existing release can be redeployed without rebuilding. The migrate Job name no longer contains dots.
- [x] #74 **The API pods failed their probes with 400.** Probes reach the pod by IP, which Django's `ALLOWED_HOSTS`
      refuses; they now send `Host: api`. CI asserts it.

## v0.1.1 - Superadmin support

- [x] #79 **Admin: reach /admin/ through nginx and serve its static files.** The `web` nginx proxies `/admin/` (no-store,
      Referrer-Policy `same-origin`, since `no-referrer` makes browsers send `Origin: null` and CSRF refuses the login)
      and `/static/`; the api serves its static files with WhiteNoise (collected into `/app-static` at image build time;
      `django.contrib.staticfiles` installed); `CSRF_TRUSTED_ORIGINS` follows `TRUSTED_ORIGINS`; Vite proxies both for
      development. Tests: `accounts/test_admin.py`, `e2e/admin.spec.ts` (with a `newSuperuser()` helper).
- [x] #80 **Admin: superusers only, hardened session cookie and login rate limit.** `SuperuserAdminSite`: an active
      `is_superuser` is required to log in and for every page (staff alone gets nothing; demotion ends access at once);
      session cookie `openprism_admin` (httpOnly, Strict, Secure by the refresh cookie's rule, 8 h), CSRF cookie
      likewise; login form limited to 10 submissions per address per 15 minutes (429 `Retry-After`;
      `common.ratelimit.hit` takes a window); nginx adds `X-Frame-Options: DENY`; an admin session does not
      authenticate the API; optional Caddy block to restrict `/admin/` by address. Tests: `accounts/test_admin.py`,
      `e2e/admin.spec.ts`.
- [x] #81 **Admin: register the models read-mostly, with no credentials and no deletes that skip cleanup.** `admin.py` in
      accounts, projects, jobs, templates, collab, integrations and versions, built on `common.admin.ReadOnlyAdmin`;
      accounts editable only for name/active/staff/superuser plus a *mark email verified* action; no add/delete for
      accounts, workspaces and projects; `LogEntry` visible. Credential models, file contents and the Yjs state are
      not registered, and simplejwt's `OutstandingToken`/`BlacklistedToken` (refresh tokens) and `Group` are
      unregistered. Tests: `accounts/test_admin_models.py` (planted secrets never appear), `e2e/admin.spec.ts`.
- [x] #82 **Admin: make and revoke superadmins safely (command, last-superadmin guard, docs).** `make_superadmin` (promote,
      or create after a password prompt: verified, personal workspace) and `revoke_superadmin`, both logged in the
      admin's *Log entries*; `accounts/superadmins.check_not_last()` keeps at least one active staff superuser, in the
      commands and in the admin user form; privilege flags editable only by superusers; documented for compose and
      Kubernetes (README, Helm README). Tests: `accounts/test_superadmins.py`.
