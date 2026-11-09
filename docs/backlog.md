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


## Deploy to the cent Kubernetes cluster

Delivered (issues #64-#68): a Helm chart and a GitHub Actions workflow replace `deploy/k8s`, exposing a
NodePort for the external Caddy2 proxy and using the cluster's hosted Postgres, Redis and MinIO.

**Still to check once it runs on the cluster** (carried over from the old kind plan, now against the real cluster)
- [ ] Read-only root filesystem for the TeX worker: compile with `pdflatex`, `xelatex`, `lualatex` and `latexmk` inside
      a pod, and confirm the caches under `/tmp` work and the compile hardening still holds.
- [ ] **NetworkPolicies are missing from the chart** (the old kustomize ones are in git history, `deploy/k8s/base/networkpolicies.yaml`
      before the Helm chart replaced it): first find out whether the cluster's CNI enforces them. Default-deny must not break kubelet probes;
      `worker-compile` must have no internet; the workers that call LLM providers must reach only public HTTPS.
- [ ] Autoscaling (HPA or KEDA) is not in the chart; decide whether the shared cluster needs it.
- [ ] Rolling update: change an image tag mid-job and confirm a running compile/transfer finishes rather than being killed.
- [ ] Direct browser uploads need a browser-reachable MinIO address and bucket CORS (`S3_DIRECT_UPLOADS` is off).
- [ ] **Checks through the live Caddy** (deferred from #67, to be done when a production check is wanted; development
      testing happens in the dev environment): live editing over `/api/collab` in two browsers, a 150 MB upload, the
      arXiv-import event stream, and that `?token=` does not appear in Caddy's access log.

- [ ] **The plot sandbox is defence in depth, not a real sandbox** (moved from the security issues): AST check, builtin whitelist,
      scrubbed environment, non-dumpable worker, rlimits. LaTeX and plot code also share a user with the worker process,
      and LuaTeX can read any file that user can read. Run these workers under gVisor/Kata and cap pids.

**Decisions to make along the way**
- Whether `worker-compile` and `worker-ai` should run under a sandboxed runtime (`runtimeClassName: gvisor` or Kata).
- Whether to add PgBouncer in front of Postgres (connection count grows with API replicas).

## v0.1.1 - Superadmin support

Accounts with access to the Django admin back end. `django.contrib.admin` is installed and routed at `/admin/`, and
`createsuperuser` sets `is_staff` / `is_superuser`, but no app registers a `ModelAdmin`, so the admin is empty, and
nothing says how a superadmin is made or how the site is reached in production.

- [ ] **Reach `/admin/` in every environment.** Confirm `web` (nginx), the Helm chart's routes and the Caddy reference
      config pass `/admin/` (and its static files) through to the api, in compose and on the cent cluster.
- [ ] **Register the models with `ModelAdmin`s** so a superadmin can inspect and fix data: accounts, workspaces and
      memberships, projects (read-mostly; file contents are not edited here), jobs, templates, invites, LLM usage and
      credential events. Never show or edit stored credentials, tokens or key material (last four characters at most).
- [ ] **Make and remove superadmins safely.** A documented way to grant and revoke `is_staff` / `is_superuser`
      (`createsuperuser`, a management command, or the admin itself for existing superusers), including on Kubernetes.
      Superadmins are accounts, not a separate login; decide whether an unverified account may be one.
- [ ] **Protect the admin.** It uses Django sessions while the app uses JWTs: decide the login path, session cookie
      settings (`Secure`, `SameSite`), CSRF trusted origins behind the proxies, rate limiting on the admin login, and
      whether `/admin/` is restricted to certain addresses at Caddy.
- [ ] **Audit superadmin actions.** Admin edits are written to Django's log entries; decide whether to also record them
      in the credential event log or keep them admin-only, and show who acted.
- [ ] **Tests.** Superadmin can load the changelists; a normal or staff-without-permission account cannot; secrets never
      appear in the admin pages.

## v0.1.2 - A) Invitation-only access

**Plan, to be fleshed out before issues are written.** Needs v0.1.1 (the Django admin is where a superadmin manages
this). Keeps strangers who find the URL from signing up.

Where we are today: `REGISTRATION_MODE=invite` accepts an address only if a *workspace* invitation (`WorkspaceInvite`,
made by a workspace admin) exists for it. That is not the same thing: nobody can be let onto the platform without being
attached to a workspace, workspace admins can open the door on their own, and the landing page and `/register` still
invite strangers to sign up.

- [ ] **Model.** A `PlatformInvite` (email, hashed single-use token like `CollabInvite`, `invited_by`, expiry, `used_at`,
      the account it created, optional workspace and role to join on registration). Decide: one invite per address or
      several, default expiry, whether an invite survives a registration that fails halfway.
- [ ] **Registration requires one.** Registration is refused without a valid invitation for that address. Decide how it
      relates to workspace invitations (suggested: a workspace admin may invite only people who already have an account
      or hold a platform invitation, so the superadmin controls who is on the service).
- [ ] **A single gate that every sign-up path goes through,** so B's social sign-in cannot bypass it (with allauth this
      is `is_open_for_signup` on the account and social-account adapters).
- [ ] **Superadmin manages them in the admin.** Create (one address or a pasted list/CSV), resend, revoke, see status
      (sent, mail failed, used, expired) and who invited. Reuses `mail.send_template` and the `send_failed` pattern.
      Only superusers, not plain staff.
- [ ] **The invitation proves the address.** The mailed link (`/register?invite=…`) carries the token and pre-fills the
      email; completing registration marks the address verified.
- [ ] **No enumeration, no guessing.** Wrong, expired and used tokens give one generic error; rate-limit registration per
      address and token (`common/ratelimit.py`); the register endpoint must not reveal which addresses are invited.
- [ ] **The public site stops advertising sign-up.** Landing and `/register` say access is by invitation and show a
      contact address (setting). Decide whether to add a "request access" form (probably not in this release).
- [ ] **Existing accounts keep working;** `createsuperuser` remains the way to bootstrap the first superadmin on an
      invitation-only deployment (document it for compose and Kubernetes).
- [ ] **Tests and QA:** unit tests for the gate (no invite, expired, used, wrong address, rate limit) and the admin
      actions and permissions (staff without superuser cannot); Playwright for the invited registration flow and the
      closed landing and register pages.

## B) Social sign-in, two-factor and passkeys

**Use cases:** sign in with a social/SSO provider; one account that can be reached by several sign-in methods (separate
the account from its email and sign-in method); two-factor authentication; passkeys.

**Recommended tool: django-allauth** (MIT). It is the one package covering all four: `socialaccount` (OAuth/OIDC
providers incl. Google, GitHub, ORCID, generic OIDC, SAML), an identity model that is separate from the user (several
email addresses and several linked social accounts per `User`), `allauth.mfa` (TOTP, recovery codes, WebAuthn security
keys and passkeys, passkey login), and `allauth.headless`, a JSON API for single-page apps with a configurable token
strategy (sessions or JWT). Alternatives considered: `dj-rest-auth` (a thin layer over allauth, no passkeys of its own),
`python-social-auth` (social only), `django-otp` / `django-two-factor-auth` (two-factor only, server-rendered), and a
hosted identity provider (Keycloak, Authentik, Auth0: strongest, but a new service to run on the cluster). Setting names
and defaults change between allauth releases: check the official docs for the pinned version.

**The hard part is the token contract, so start with a spike.** The React app keeps an access token in memory and a
rotating httpOnly refresh cookie (`api/auth.ts`, `accounts/cookies.py`, `e2e/session.spec.ts`), with URL tokens for
websockets and images. The spike must show allauth headless can sit behind that: either its JWT token strategy or, better,
allauth doing the authentication step (password, social, second factor, passkey) and then handing over to our existing
SimpleJWT + cookie issuing, so the rest of the app is untouched. It must also prove multi-tab refresh and logout still
work and that a refresh cannot bypass a second factor.

- [ ] **Spike (time-boxed).** Install allauth + headless + mfa in a branch, keep email-login `User`, log in through it and
      mint our tokens; report what has to change. Go/no-go before anything else is built.
- [ ] **B1 Foundation.** Migrate existing accounts (an `EmailAddress` row per user with its verified state, no one
      locked out); move password reset, verification and email change onto allauth while keeping the existing mail
      templates and `REQUIRE_EMAIL_VERIFICATION`; keep "a password change revokes refresh tokens", the credential
      event log and account deletion. Closes the follow-up "no way to change the account's email address".
- [ ] **B2 Two-factor (TOTP + recovery codes).** Enrol and disable from the Account page; login asks for the code; a
      superadmin can reset a locked-out user's second factor (audited). Required for superadmins.
- [ ] **B3 Passkeys.** Register and sign in with passkeys (WebAuthn). The relying-party id is the public host
      (`openprism.cent-su.org`; `localhost` in development); check it behind Caddy and nginx.
- [ ] **B4 Social sign-in.** Providers to choose (Google, GitHub, ORCID, university OIDC/SAML). **Still requires an
      invitation (A).** Link a provider to an existing account only by an email the provider reports as verified (an
      unverified provider email is an account-takeover route); never create a second account for an invited address.
- [ ] **B5 Account page: sign-in methods.** List and add/remove email addresses, social accounts, passkeys and the
      second factor; refuse to remove the last way to sign in; recent sign-ins.
- [ ] **Decisions:** allauth headless, or the hosted identity provider route; which providers; whether two-factor is
      optional for everyone or required (superadmins first); sign-in-method changes mail the user.
- [ ] **Tests and QA:** unit tests per flow (including that every sign-up path passes the invitation gate and that
      refresh/impersonation cannot skip a second factor); Playwright with a virtual authenticator for passkeys and a
      fake OIDC provider for social login.

## C) Superadmin impersonation ("view as")

**Use cases:** a superadmin checks role-based security (what does a viewer, commenter or editor actually see?) and
troubleshoots a user's live problem by seeing what they see.

**Existing packages do not fit.** `django-hijack` (3.x, superuser-only by default, start/end signals, admin button) and
`django-impersonate` both swap the Django *session* user. The app's API authenticates with JWT bearer tokens and does not
use sessions, so using either would only change who `/admin/` thinks you are, not what the React app shows. A search found
no Django package that impersonates through bearer tokens (check each package's current docs before building). The
standard pattern for tokens is to carry the impersonation inside the credential, an `act` ("actor") claim as in OAuth
token exchange (RFC 8693), so that is what to build, small, on SimpleJWT, borrowing hijack's rules and signals.

- [ ] **Start it from the admin.** A superuser-only *View as* action on a user opens the app as that user (a one-time
      code exchanged for a short-lived access token with an `act` claim naming the superadmin, **no refresh cookie**, so
      it ends by itself and cannot be renewed); `POST /api/admin/impersonate` underneath.
- [ ] **Read-only by default.** Writes, AI/compile jobs, file uploads and joining live rooms are refused while viewing;
      decide whether an explicit, logged "allow changes" mode is needed.
- [ ] **Hard limits.** Never another superuser or staff account; never a user's stored keys (AI, Zotero, workspace
      providers); no password or email change, no account deletion, no credential history; second-factor and sign-in
      method settings hidden (see B).
- [ ] **Always visible, always logged.** A banner in the app ("Viewing as …, Stop"), a log of who, whom, when, how long
      and why (a required reason), the real actor on any audited action, and a notice to the user (decide: mail, in-app
      or none).
- [ ] **Works across the stack:** the user's permissions are evaluated exactly as for them (membership, invite roles);
      guest-link projects too. URL tokens minted while impersonating carry the claim.
- [ ] **Role preview (optional, cheaper):** "preview as role" on a workspace for admins (no user data involved) to check
      Owner/Admin/Editor/Commenter/Viewer without anyone's account.
- [ ] **Tests and QA:** unit tests for who may impersonate, the hard limits, expiry without refresh and the log;
      Playwright for the banner and the read-only behaviour.

## Operations

- [ ] **No observability.** No metrics, structured logs, tracing or alerts; no view of queue depth, failed jobs, or
      websocket counts. (Queue depth is also the better autoscaling signal, KEDA scaled on it in the removed kustomize tree.)
- [ ] **No backup or restore story** for Postgres or the object store, and the local-cluster data stores are single
      instances.
- [ ] **Data-service defaults are placeholders.** Everything in `.env.sample` and `overlays/local` (passwords, storage
      keys, `DJANGO_SECRET_KEY`) is for development only; a real deployment needs generated secrets and a rotation plan.


## Follow-ups: in-place AI editing

- [ ] **Accepting a proposal writes other files by REST, even when someone has them open live** (known collaboration
      limitation). A multi-file proposal only goes through the shared document for the active file.
- [ ] **In-place AI undo in a live session** is the editor's own history; check that Ctrl+Z in a collaborative session undoes
      only the local user's accept (y-codemirror's undo manager) and does not undo remote edits.
- [ ] **No streaming.** The bar shows step names, not the model's text; long tasks look idle between steps.
- [ ] **Cite and bibliography tasks** ("cite the Attention paper") need the Zotero/arXiv tools in edit mode and a recorded task.
- [ ] **A configurable shortcut** (Ctrl/Cmd+K is fixed; browsers bind Ctrl+K to the address bar when the editor is not focused).
- [ ] **A cancelled request can still finish its current model call** (the worker checks between calls), and a cancel sent
      before the job row exists is lost.


## Follow-ups: account management and comments

- [ ] **No way to change the account's email address** (it would need re-verification and must not orphan invitations).
- [ ] **Comment notifications.** Nobody is told about a new comment or reply (mail digest, @mentions, an unread count).
- [ ] **Comment gutter markers** were left out; highlights only. Long files need a way to see where comments are.
- [ ] **Permanently deleting a project leaves its compile jobs' storage** (`jobs/<id>/` prefixes) until the job rows age
      out; account deletion inherits this. Delete the prefixes with the project.
- [ ] **Comments on live text are placed against the stored file on the server**, which can lag the live document by
      ~800 ms; the editor re-places them against its live text, but the API's `anchor` may briefly disagree.
- [ ] **Two owners can no longer demote each other** (owners are fixed once made); decide whether an owner may step down.

## Follow-ups: security

- [ ] **The plot sandbox is defence in depth, not a real sandbox** (AST check, builtin whitelist, scrubbed environment,
      non-dumpable worker, rlimits). LaTeX and plot code also share a user with the worker process, and LuaTeX can read
      any file that user can read. Run these workers under gVisor/Kata and cap pids (see the Kubernetes item)

## Follow-ups: live-write and restore cleanup

- [ ] **Zotero's `applied: false` hand-back and version restore's 409 for open files predate #54.** Now that REST text
      writes reach open rooms, the Zotero add could always write, and restore could write text files behind live rooms
      (binary/removed files still need thought). Simplify both and their editor code.

## Follow-ups: version history

- [ ] **New model fields have no database default, so old code breaks during a rollout.** `ProjectVersion.status`,
      `log_key` and `log_size` (and any later field) use Django defaults, which the old code does not send: between the
      migration and the worker restart, every version insert failed (the compile still succeeded, the version was lost).
      Use `db_default` for new non-null fields, and document "restart workers after migrating" for compose.
- [ ] **The PDF comparison's highlight paints both versions' ink** where a word changed, so the changed text is hard to
      read in Highlight mode; consider tinting only the after page's pixels and outlining removed areas.
- [ ] **The Compare dialog closes at phone width when the editor collapses its right panel** (it lives inside the
      Versions panel). Opening it at phone width works.


## Follow-ups: imports, auth and AI usage

- [ ] **The arXiv import stream holds a web thread for up to 16 minutes** (`import_arxiv_sse` relays the job's progress
      over SSE). Move it to the same job polling as the AI endpoints.
- [ ] **Template ZIP upload and project ZIP import still pass through the API** (direct uploads cover project files
      only).
- [ ] **The client's refresh retry after 1.5 s (`api/auth.ts`) was for the dev clock steps**, which `JWT_LEEWAY_SECONDS`
      (#57) now absorbs in the compose stack. Remove the retry once browser runs show it is never taken.
- [ ] **The dev api's hot reload can hang** ("Waiting for connections to close") while a browser holds an SSE stream or
      websocket open; `docker compose up -d --force-recreate api` recovers. Consider `--timeout-graceful-shutdown`.
- [ ] **AI usage counts requests, not tokens.** Record the providers' reported `usage` per job for spend accounting.