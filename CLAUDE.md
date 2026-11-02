# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository. User-facing setup lives in `README.md`; this file holds what you need to change the code safely.

## What this is

OpenPrism is a local-first LaTeX + AI workspace for academic writing: a three-panel web app (file tree / CodeMirror LaTeX editor / PDF preview) with an LLM assistant (chat/agent/tools modes), LaTeX compilation, template management, LLM-powered template transfer (migrating a paper between conference templates), real-time multi-user collaboration (Yjs CRDT), and peer-review tooling.

**Stack:** React frontend + Django REST/Channels API + Celery workers + Postgres + Redis + Garage (S3), run locally with `docker compose` and in Kubernetes via `deploy/k8s`. The former Node/Fastify backend is gone (`apps/backend` was deleted at cutover; see git history before the Phase 7 commit). Done: data services, models/auth/files/templates, async compile, AI endpoints, template transfer, arXiv import, collaboration, accounts + workspaces UI, the production `web` image, and the Kubernetes manifests. **The Kubernetes manifests have been rendered and statically checked but never applied to a cluster**: read `deploy/k8s/README.md` ("Unverified") before trusting them.

## Running and testing

Develop inside the devcontainer (Node 20, TeX Live, docker-in-docker so `docker compose` works). Forwarded ports: 5173 (Vite), 8080 (nginx app), 8000 (API), 5432, 6379, 3900.

```bash
cp .env.sample .env                 # once; add OPENPRISM_LLM_* / OPENPRISM_MINERU_TOKEN for server-side AI defaults
docker compose up -d --wait         # postgres, redis, garage, api, worker-tex, worker-ai, beat, web
deploy/garage-init.sh               # one-time, idempotent: Garage layout, bucket, access key (reads S3_* from .env)
npm install
npm run dev                         # Vite on :5173, proxies /api + websockets to the api on :8000
```

- **Use the app** at http://localhost:5173 (hot reload) or http://localhost:8080 (the production `web` image). Register an account in the UI; there is no seeded user.
- **Legacy data:** `docker compose exec api python manage.py import_legacy --owner you@example.com` loads `templates/` and `data/` (mounted read-only at `/legacy/`) into an account. Register that account first.
- **API tests** (real Postgres/Redis/Garage; run `deploy/garage-init.sh` once first; always pass `--noinput`, since a stale `test_openprism` database otherwise blocks on a prompt):
  - `docker compose run --rm api python manage.py test --noinput` (LaTeX/plot tests skip here)
  - `docker compose run --rm worker-tex python manage.py test jobs transfer --noinput` (real pdflatex/bibtex)
  - `docker compose run --rm worker-ai python manage.py test ai --noinput` (real matplotlib + plot sandbox)
- **Browser tests** (Playwright, `apps/frontend/e2e`): with the stack and `npm run dev` running, `npm --workspace apps/frontend run e2e` from the repo root (there is no root `e2e` script) (`E2E_BASE_URL=http://localhost:8080` tests the nginx image). One-time: `npx playwright install chromium && sudo npx playwright install-deps chromium`. Each test registers its own account and project. Add a spec for any UI behaviour you change, and check that it fails on the old code.
- **Logs / restarts:** `docker compose logs -f api worker-tex`. Celery does not auto-reload: after editing task code run `docker compose restart worker-tex worker-ai beat`. The api reloads itself (code is bind-mounted). After rebuilding an image use `docker compose up -d` (not just `build`) so containers are recreated.
- **Reset / migrations:** `docker compose down` keeps volumes (`-v` wipes all data). After model changes: `docker compose run --rm api python manage.py makemigrations <app>` and commit the migration. `docker compose up` runs `migrate` on every api start (fine for dev; in k8s it is a one-off Job).
- **Health:** `curl localhost:8000/healthz` (liveness), `localhost:8000/readyz` (Postgres + Redis + S3; 503 otherwise), `localhost:8080/healthz` (web).
- **Version:** the single source is `apps/api/VERSION` (semver, no `v`). The API returns it from `/healthz` and `/readyz`, Vite injects it as `__APP_VERSION__` (shown at the bottom of the account menu), and the web Dockerfile copies the file in. Bump it on the release branch; git tags are `vX.Y.Z` (`v0.0.0` is the pre-versioning baseline).
- Use plain `docker compose`, not npm wrappers. `npm run build` / `npm run preview` only build/preview the frontend.
- **Bind mounts and git.** The api/worker containers bind-mount `apps/api` and the data services mount single files. Anything that deletes and recreates those paths (e.g. checking out a branch that lacks them, then switching back) leaves containers pointing at deleted directories: `docker exec` fails with "current working directory is outside of container mount namespace root", health checks go unhealthy, and services keep running old code. Fix: `docker compose up -d --force-recreate`.
- **Static checks:** there is no JS test suite and no lint/format config. `tsc --noEmit` in `apps/frontend` reports 7 pre-existing type errors (CodeMirror/Blob/listener typings); keep it at 7. For UI changes, verify in a real browser (Playwright can be installed outside the repo: `npm i playwright` in a scratch dir). Vite uses file polling because the bind-mounted workspace does not deliver change events.
- LaTeX compile needs a TeX engine; only the `worker-tex` image carries full TeX Live (the devcontainer has `latexmk` + a subset of `texlive-*`).

## Conventions
- Requirements live in `docs/`. If a request contradicts them, say so rather than guessing.

- Commit messages say what was decided, not just what changed. "Update file" is never acceptable.

## Instructions for Claude

1. Project planning goes on the backlog in `docs/backlog.md`. These should be grouped logically by user story or feature. New issues and bugs start here.
2. `docs/todo.md` Contains items moved from `docs/backlog.md` that we are working on NOW. We should complete the todo's before working on the next backlog item. 
3. We don't write code unless there is a GitHub issue for it.
4. Each todo should land in Github as an issue to be coded, issues numbers tracking back to the item. It should be labeled / tagged with its Epic (usually a version number like v0.0.1)
5. All GitHub issues should be well-defined so a programmer of moderate ability can complete the task trivially.
6. All GitHub issues should have acceptance criteria and definition of done sections, suitable for a product manager.
7. Track the Github issue back to the backlog version number with labels ex: v1.10.0, US01, etc.
8. Do not wander off task. If you encounter a bug, feature or enhancement idea while working, add it to the backlog and label it. 
9. Code in a `dev/<issue>-<slug>` branch cut from the current release branch (`release/vX.Y.Z`) and merge it back with `--no-ff`. The release branch merges to `main`, tagged, when every issue in it is closed.
10. We test the code we write. Unit and integration tests.
11. An issue is not done until tests pass, the server runs and the app runs without error.
12. As you close Github issues review `docs/todo.md` and move completed items into `docs/xchangelog.md`
13. Start each issue from the release branch with a clean working directory.



## Configuration

Everything is environment variables. `.env` at the repo root (copied from `.env.sample`, gitignored) is passed into the devcontainer via `runArgs --env-file` and read by compose for `${VAR}` interpolation. Compose supplies container-side URLs (`postgres`, `redis`, `garage`) itself, so `.env` values like `DATABASE_URL=...@localhost` are for tools running in the devcontainer, not for compose services.

- **API and workers** (`apps/api/config/settings.py`): `DJANGO_SECRET_KEY` (**required, no default; startup fails without it**), `DJANGO_DEBUG`, `DJANGO_ALLOWED_HOSTS`, `DATABASE_URL`, `REDIS_URL` / `CELERY_BROKER_URL`, `S3_ENDPOINT_URL` (internal), `S3_PUBLIC_ENDPOINT_URL` (browser-reachable; used in presigned links), `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `JWT_ACCESS_MINUTES`, `JWT_REFRESH_DAYS`. Settings parse `DATABASE_URL` themselves (no django-environ); add new config via `env()` / `env_bool()`. The `.env.sample` values (all-zero Garage secrets, `dev-insecure-change-me`) are dev placeholders: never reuse them on a shared deployment.
- **Frontend** LLM/MinerU settings live in browser `localStorage` (`openprism-settings-v1`) and are sent per request; the API never stores the keys. Account tokens: `openprism-auth-v1` (localStorage). Invite token: `openprism-collab-token` (sessionStorage).
- New dependencies go in `apps/api/requirements.txt` as exact pins, then `docker compose build api`.

## Architecture

Monorepo: `apps/frontend` (React 18 + TypeScript + Vite; the only npm workspace), `apps/api` (Django + Celery + Channels, built from `apps/api/Dockerfile`), and `design/` (shared UI package imported as `@design`). `compose.yaml` runs everything locally.

### Components (one image/Deployment each in k8s)

| Component | Tech | Role |
|---|---|---|
| `web` | nginx + built frontend (`apps/frontend/Dockerfile`, `nginx.conf`) | Serves the SPA (history fallback, hashed assets cached), proxies `/api` incl. websockets and SSE to `api:8000`, 200 MB uploads. Logs omit query strings (tokens travel in `?token=` for images/PDFs/event streams/websockets) and it sends `Referrer-Policy: no-referrer` so they cannot leak. Build context is the repo root (the frontend imports `/design`) |
| `api` | Django + DRF + Channels, uvicorn (ASGI) | Stateless REST **and the collab websocket** (`/api/collab`); `/healthz`, `/readyz`. Scales horizontally: replicas sync through Redis, no sticky routing |
| `worker-tex` | Celery, queues `compile` + `transfer` | TeX Live image (template transfer compiles LaTeX and also calls LLM/MinerU). Per-command timeout, CPU/file-size rlimits, shell-escape off. Set container CPU/mem limits in k8s |
| `worker-ai` | Celery, queues `ai` + `import` | LLM, vision, plot (runs LLM-generated Python), agent, arXiv import. Image adds matplotlib/pandas/seaborn (`requirements-ai.txt`) |
| `beat` | Celery beat | Reaps jobs whose worker died, deletes finished jobs after 24 h (expired collab invites: not yet) |
| `postgres`, `redis`, `garage` | | In `compose.yaml`; managed services/operators in k8s |

Design rules: services are stateless and 12-factor (env-only config, no shared volumes; workers materialise project files into a temp dir), long operations become `Job` rows + Celery tasks that the frontend polls, and nothing user-visible depends on local disk.

### Django API (`apps/api`)

Apps: `accounts` (email-login `User`, register/login/refresh/me), `projects` (`Workspace`, `Membership`, `Project`, `ProjectFile`, file service, REST views), `templates_app` (`Template` + S3 template files), `jobs` (`Job` model, compile service + tasks, job API), `ai` (LLM client, agent, plot sandbox, arXiv, AI task + endpoints), `transfer` (template-transfer engine, nodes, MinerU client, endpoints), `collab` (invites, guest auth, Yjs rooms, websocket consumer), `common` (health, `{ok,error}` exception handler, path-preserving multipart parser, safe zip reader). `config/` has settings, urls, asgi, and the Celery app.

**Data model.** `Project` (name, tags, archived, trashed/trashed_at, `file_order` JSON) belongs to a `Workspace`; users reach projects through `Membership` roles (`owner`/`admin`/`editor` can write, `viewer` is read-only). Registering creates a personal workspace. A non-member gets **404, not 403**, so project existence is not revealed.

**File storage: go through `projects/files.py`, never touch `ProjectFile` rows or S3 directly.** Text files (by extension, see `projects/paths.py`) live in Postgres (`ProjectFile.content`); binaries live in Garage under random keys `projects/<projectId>/<uuid>`, so renames are DB-only; templates live under `templates/<id>/`. Directories are implicit from path prefixes (explicit `dir` rows exist only for empty folders). Always validate user paths with `safe_path()` (rejects absolute paths, `..`, NUL) or `sanitize_upload_path()` (lenient, for uploads/zips). The service refuses to put a file under a file or replace a directory.

**API conventions** (match `apps/frontend/src/api/client.ts`; change client and server together):
- Errors are `{ok: false, error: "<message>"}`. Business errors (missing name, tags not an array, delete of a missing file) return HTTP 200 with that body, as the Node backend did; auth/permission/not-found/bad-path use real status codes.
- Project meta is camelCase (`createdAt`, `updatedAt`, `trashedAt`, `fileOrder`, `workspaceId`), ISO timestamps ending in `Z`.
- Auth is `Authorization: Bearer <JWT>`. Only `GET /api/projects/:id/blob` also accepts `?token=` (for `<img>`/`<object>`); it responds with `Content-Security-Policy: sandbox` so uploaded SVG can't run script.
- Folder uploads send relative paths in the multipart *filename* (`form.append('files', file, 'figs/a.png')`). Django normally strips this to a basename; `common/uploads.py` preserves the sanitised path as `file.full_path`, read via `upload_path()`. In tests build such bodies by hand (the Django test client strips paths too; see `multipart()` in `projects/test_api.py`).
- Presigned URLs (currently unused by the UI) are signed for `S3_PUBLIC_ENDPOINT_URL`, so tests fetch them through the internal endpoint with the public `Host` header.
- Behind proxies, set `TRUSTED_PROXY_COUNT` to the number of proxies in front of the API (compose: 1, Kubernetes: 2); otherwise all users share the proxy's address and the login rate limit.

**Async jobs (compile).** Long work is a `Job` row plus a Celery task; the API never blocks on it. `POST /api/compile {projectId, mainFile, engine}` validates, then returns `{ok, jobId}` (max 3 active compiles per user → 429). `GET /api/jobs/:id` returns `{status: queued|running|success|failed, progressLog, error, result}` (`result` = `{log, status, engine, mainFile, pdfUrl}` once finished). `GET /api/jobs/:id/pdf` streams the PDF from Garage through the API (authenticated, also accepts `?token=`), so browsers never need direct access to Garage. The `compile_project` task (`jobs/tasks.py`) runs in the `compile` queue with `acks_late`: if a worker dies the message is redelivered, so tasks must be safe to re-run (it skips finished jobs). `updated_at` is the heartbeat; `reap_stale_jobs` fails jobs idle >10 min running / >30 min queued.

`jobs/compile.py` materialises the project (text from Postgres, binaries from S3) into a temp dir, runs engine → bibtex/biber (biber if `.aux` has `\abx@aux@` or the source uses biblatex) → 2 more passes, treats "a PDF exists" as success even if the engine exited non-zero, and always deletes the temp dir. Log output is capped at 200 KB. `tectonic` is accepted by the API but not installed in the worker image (reports "tectonic not available").

**Source→PDF position (SyncTeX).** Every engine compiles with `-synctex=1` (latexmk via its `-pdflatex=` command). If the request carried `focus: {file, line}` (the editor sends the caret's line), `forward_search()` runs `synctex view` inside the same temp dir (while the paths in the SyncTeX data still exist) and returns `{page, x, y}` (PDF points from the page's top-left) as `result.focus`. It is best effort and never fails a compile: a malformed hint is dropped by the API, a blank/comment line falls back to the nearest line with output (±12), a file not part of the compile or a failed compile gives `null`, and a line past the end snaps to the last page. The SyncTeX file is untrusted input, so `synctex` runs through `run_command`.

New async features follow this pattern: model in `jobs`, task in `jobs/tasks.py`, route to a named queue in `CELERY_TASK_ROUTES`, status via `/api/jobs/:id`.

**AI endpoints (`apps/api/ai`).** `/api/llm`, `/api/agent/run`, `/api/vision/latex`, `/api/plot/from-table` create a `Job`, enqueue `ai.tasks.run_ai_job` on the `ai` queue and **block up to `AI_WAIT_SECONDS` (300) polling the DB**, so response bodies stay as they were under Node (stored in `job.result['body']`). If the wait runs out the reply is `{ok: false, error, jobId}` and the job keeps running; `GET /api/jobs/:id` then returns the body as `result`. A waiting request holds a web thread: scale `api` accordingly or move clients to polling. `arxiv/search` and `arxiv/bibtex` are quick and run inline in the api. Keep these true when changing this code:
- **API keys never touch Postgres or the Celery result backend.** The view splits `llmConfig` into public fields (`model`, `endpoint`; stored in `Job.params`) and `{apiKey}`, which travels only as a task argument (briefly in the Redis broker; the task is `ignore_result`). Falls back to `OPENPRISM_LLM_*` env vars on the worker. `AiApiTests.assert_key_not_persisted` guards this.
- **SSRF guard** (`ai/ssrf.py`): user-supplied LLM endpoints that resolve to private/loopback/link-local addresses are refused unless `LLM_ALLOW_PRIVATE_ENDPOINTS=1` (dev only, for local models; compose passes it to `worker-ai`). DNS rebinding between check and request is a known gap: use NetworkPolicies in k8s.
- **The agent** (`ai/agent.py`) talks to the OpenAI tools API directly (no LangChain): up to 15 tool steps; tool failures go back to the model as `Error: …` text instead of aborting; patches are only *proposed* (`{path, original, content, diff}`), never written. Unified diffs are built/applied by `ai/patches.py` (tolerates shifted hunks and stripped blank context lines).
- **Plot** (`ai/plot.py` + `plot_runner.py`) runs LLM-written Python in a subprocess: AST check (no imports/dunders/introspection) → whitelisted builtins → scrubbed environment → rlimits + timeout → temp dir deleted. This is defence in depth, **not a real sandbox** (e.g. `plt.sys.modules` is reachable). Real isolation must come from the deployment: `worker-ai` with no extra secrets, a pids limit, and a NetworkPolicy denying egress except LLM providers.
- Tests fake the LLM with a local HTTP server (`FakeLLM` in `ai/tests.py`) and run the task inline; real-Celery routing was verified manually with `docker compose up worker-ai`.

**Template transfer (`apps/api/transfer`).** Port of the LangGraph pipeline with the same endpoints and `{status, progressLog, error}` shape as Node (`pending|running|waiting_images|success|failed`), but nothing blocks: `/start` creates the target project from the template and a `Job`; the **first `/step` claims the job and enqueues segment 1; later `/step` calls are read-only status polls**, as is `/status/:id`.
- **Hand-written state machine, not LangGraph** (`transfer/engine.py`; LangGraph's checkpointer would write the API key into Postgres). It runs nodes (`transfer/nodes.py`, one function per Node file) in *segments*: a segment ends at the pause before `checkLayout` (status `waiting_images`) or at `finalize`. `POST /submit-images` stores the screenshots in S3, bumps the segment number and enqueues the next segment. Only small state persists between segments (`engine.PERSISTED`: counters, compile/layout results, S3 keys); large intermediates (source, Markdown, plan) live in memory for one segment, so **a segment must be restartable from its entry point** (`start` or `checkLayout`). A stale or duplicate segment is ignored (segment number) and a Postgres advisory lock stops two workers running the same job.
- **Secrets** (LLM key, MinerU token) live in Redis under `openprism:job-secrets:<jobId>` with a TTL (`JOB_SECRET_TTL_SECONDS`, 6 h, refreshed on use) via `common/secrets.py`, and are deleted when the job ends, fails or is reaped. Never put them in `Job.params`/`result`/`progress_log`; `TransferApiTests.assert_no_secrets_in_db` guards this.
- Snapshots of files the pipeline overwrites go to S3 (`jobs/<id>/snapshots/…`), not the project tree. The final PDF is `jobs/<id>/output.pdf`, served by `GET /api/jobs/:id/pdf`.
- A worker crash fails the job (reaped after 10 idle minutes); there is no auto-resume because the key was never persisted. Compile "success" means a PDF exists even if the engine exited non-zero, so `fixCompile` only fires when no PDF is produced.
- MinerU (`transfer/mineru.py`): the user-supplied `apiBase`, the upload URL and every redirect hop of the result download pass the SSRF guard; result-zip paths are validated strictly (unsafe path = error).
- **Known frontend gap (pre-existing):** `TransferPanel` stops at `waiting_images`, and nothing renders PDF pages or calls `transferSubmitImages`, so `layoutCheck` cannot complete from the UI. The backend side is implemented and tested.

**arXiv import.** `GET /api/projects/import-arxiv-sse?arxivIdOrUrl=&projectName=&token=` creates an `import` Job (queue `import`, worker-ai) and relays its progress as SSE `progress`/`done`/`error` events (auth via `?token=` since EventSource can't set headers). The task streams the download to a temp file, unpacks it with path/link/size checks (tar, or a single gzipped `.tex` saved as `main.tex`), and deletes the project if anything fails.

### Real-time collaboration (`apps/api/collab`)

Wire-compatible with the browser's `CollabProvider` (`apps/frontend/src/collab/provider.ts`; standard y-websocket framing: type 0 = sync, 1 = awareness; one `Y.Text` named `content`) at `ws(s)://…/api/collab?projectId=&file=&token=`. Built on **`pycrdt`** (Yrs bindings) + a Channels `AsyncWebsocketConsumer`; `pycrdt-websocket` was *not* used because we need our own auth, read-only enforcement and cross-replica fan-out. Gotcha: every `pycrdt` message helper (`create_sync_message`, `create_update_message`, `handle_sync_message`'s reply, …) already includes the outer message-type byte; don't prefix it again.
- **Rooms** (`rooms.py`): one `Room` per open file per process (`RoomManager`), holding a `pycrdt.Doc`, awareness, and the local connections (each with an outbox queue so Yjs callbacks never block). A room is evicted `COLLAB_ROOM_EVICT_SECONDS` (60) after its last client leaves, after a final flush.
- **Durable state** (`models.CollabDoc`, `store.py`): rooms load the Yjs *state*, not the file text, so every replica starts from the same CRDT history. Seeding from file text happens once, under a Postgres advisory lock (two replicas seeding independently would duplicate content on merge). On load, text that changed outside collaboration (REST edit, template apply…) is diffed in as a normal edit: **the file wins when a room starts**. A flush merges (never overwrites) with the stored state and writes the text into `ProjectFile` in one transaction; it runs `OPENPRISM_COLLAB_FLUSH_DEBOUNCE_MS` (800) after edits and every `COLLAB_SYNC_INTERVAL_SECONDS` (30) as anti-entropy.
- **Multiple replicas** (`coord.py`): updates, awareness and control messages go over Redis pub/sub (`collab:room:<sha1>`), tagged with the sender's instance id. Pub/sub is fire-and-forget, so a replica that opens a room publishes its state vector and replicas already holding it answer with the missing update plus their cursors (otherwise a late replica misses edits still unflushed in another process). Lost messages heal at the next flush/merge. Replica liveness is a Redis zset (`collab:holders:*`), so `POST …/collab/flush` publishes a flush request and waits (≤5 s) for an ack from every live holder; the editor's Save in collab mode and anything that reads the file right after use this. `GET …/collab/status` reports connections and last flush error across replicas.
- **Auth** (`consumers.authorize`, `auth.py`, `tokens.py`): the websocket accepts `?token=` as either an **invite token** or a signed-in user's **JWT access token** (membership required). There is no localhost bypass. Invite tokens are `op2.<random>`, only their SHA-256 is stored (`CollabInvite`), default 24 h (max 7 d), role `editor` or `viewer`. `POST /api/projects/:id/collab/invite {role?}` needs write access; `GET /api/collab/resolve?token=` is public. **Viewers are read-only server-side**: their sync step-2/update frames are dropped (they still receive content and show cursors). Rejections are real close codes sent after accept (1008 unauthorised/not found/invalid path, 1003 binary file).
- **Guests:** the same invite token is the REST credential for people without an account (`Authorization: Bearer op2…`, or `?token=` on blob/PDF URLs). `InviteAuthentication` yields a `GuestUser` confined to one project. The default permission is `IsRealUser` (guests refused everywhere); project-scoped views opt in with `@permission_classes([IsUserOrGuest])` (tree/file/blob/upload/files/folder/rename/file-order, compile, job status/pdf, collab flush/status), and `get_project()`/`get_job()` enforce the project and write role. Guests cannot list/create projects, call AI endpoints, or administer the project. **Any new project-scoped view that guests should reach needs that opt-in; anything else is automatically refused.**
- **Async DB access** goes through `collab/dbasync.py` (`thread_sensitive=False`, thread pool). `channels.db.database_sync_to_async` runs *all* calls of a process in one thread, so one slow flush would stall every room. Tests set `CONN_MAX_AGE=0` so pool-thread connections don't block `DROP DATABASE`.
- **Known limitations:** REST writes to a file while someone has it open are overwritten by the next flush (the editor writes through the Yjs doc in collab mode). Renaming/deleting a file drops its stored Yjs state, but a room still live for the old path can recreate the file at its next flush. Awareness entries of a crashed replica linger until clients reconnect. Rooms persist at most every 800 ms, so a hard crash can lose that window.
- **Verifying against the real client stack:** `node apps/api/collab/interop/yjs_client.mjs <baseUrl> <inviteToken> <projectId> main.tex [<secondReplicaBaseUrl>]` drives the genuine `yjs`/`y-protocols` libraries against a running stack; with a second URL (e.g. `docker compose run -d --no-deps -p 8001:8000 api uvicorn config.asgi:application --host 0.0.0.0 --port 8000`) it exercises two processes over Redis. Unit tests: `docker compose run --rm api python manage.py test collab --noinput` (uses `channels.testing.WebsocketCommunicator`; `daphne` is installed only because `channels.testing` imports it).

### Running untrusted code safely (compile and plot workers)

Anyone who can edit a project (including an invite-link guest) controls the LaTeX that `worker-tex` compiles, and an LLM writes the Python that `worker-ai` runs for plots. These rules keep that safe; each is covered by a test that fails on the old code (`jobs/tests.py` `HostileDocumentTests`, `ScrubbedEnvironmentTests`; `ai/tests.py`):
- **Child processes get an allow-listed environment, never a copy of the worker's.** `jobs.compile.run_command` *requires* an explicit `env`; `_tex_env()` builds it (PATH/locale only, `HOME` = the per-compile temp dir, `shell_escape=f`, `openout_any=p`, `openin_any=p`). The worker's environment holds the database and storage credentials, and a document can print anything its process can read (including `/proc/self/environ`).
- **Worker processes are non-dumpable** (`config/hardening.py`, applied on `worker_init`/`worker_process_init` in `config/celery.py`), so the kernel refuses children access to `/proc/<ppid>/environ` and memory. This protects against LuaTeX's Lua `io.open` (unrestrictable: `--safer` breaks luaotfload) and `plt.sys.modules['builtins'].open(...)` in plot code. Don't put credentials in *files* the worker's user can read, for the same reason.
- `openin_any=p` applies to every engine **except `lualatex`** (luaotfload cannot run in paranoid mode). `latexmk` runs with `-norc` (a project `latexmkrc` is Perl code: this was a remote-code-execution hole) and `biber` with `--noconf`.
- Any new subprocess running user-influenced code must scrub its environment, run from a temp dir, bound its time/memory/file size, and have a test that a hostile input cannot read credentials.

### Frontend (`apps/frontend/src`)

**Layout.** React Router app (`app/App.tsx`) with routes for landing, project list / workspace home (`app/ProjectPage.tsx`, sections via `?section=`), the editor, and a collab-invite-join page. The editor (`app/EditorPage.tsx`, styles in `app/editor-shell.css`) is icon rails + collapsible/resizable side panels around an editor/PDF split: left = Files / Outline / project Search; right = Assistant / Review / arXiv / Websearch / Vision / Plot / Collaborate; the centre has an Editor / Split / PDF switch. Layout state persists in `localStorage` (`openprism-editor-layout-v1`). `app/TransferPanel.tsx` drives Template Transfer by polling `transferStep()` and handling `waiting_images`. All backend communication goes through `api/client.ts` (which also defines the shared request/response types; there is no separate `types/` module) and, underneath it, `api/auth.ts`. In dev, Vite proxies `/api` (incl. the WebSocket upgrade) to `OPENPRISM_API_URL` (default `http://localhost:8000`) and `/texlive` to SwiftLaTeX's cloud TexLive resources; in production nginx proxies `/api`.

**Accounts, sessions and workspaces.** In order of dependency:
- `api/auth.ts` (framework-free) owns credentials. An *account session* is a JWT access + refresh pair in localStorage (shared across tabs); a *guest* credential is an invite token in sessionStorage (this tab only) and **wins while present**. `apiFetch()` adds the language header and the right bearer token, and on a 401 refreshes once (single-flight) and retries; a rejected refresh signs the account out. A timer refreshes the access token a minute before it expires so long-lived websockets keep a valid token. Refresh tokens rotate and are revoked on logout. Use `tokenForUrl()` / `blobUrl()` for anything that cannot send headers (`<img>`, `<object>`, `EventSource`, websockets); never put tokens in other URLs. Tokens in localStorage are readable by any script on the page, so **never inject untrusted HTML**.
- `auth/AuthProvider.tsx` resolves who this tab is (`loading | anonymous | guest | user`) via `/api/auth/me` or the invite's `resolve` endpoint. A change of identity goes to `loading` *immediately*; otherwise the catch-all route redirects on the stale identity (this bug made invite links land on /login). `useAuth()` exposes `signIn/signUp/signOut/leaveGuest`.
- `auth/useWorkspaceValue.ts` is the API-backed implementation of the design system's workspace contract: it loads `/api/workspaces`, remembers the active workspace per account, and wraps the member/role/invite/move calls. `guestWorkspaces()` builds the placeholder value for invite guests.
- `app/App.tsx` picks routes by auth status: anonymous → landing, `/login`, `/register`, `/collab` (everything else redirects to `/login?next=…`; `next` is only followed if it is a same-site path, see `safeNext`); guest → that one project's editor only; user → the full app, rendered only after workspaces load. Workspace roles are Owner / Admin / Editor / Commenter / Viewer (commenters are read-only until a commenting feature exists). Inviting an email with no account shows a pending "Invited" member that becomes a membership at registration (no email is sent). The editor's collab provider takes `token: tokenForUrl` (a function, evaluated on every reconnect).

**Compile contract.** `compileProject()` in `api/client.ts` hides the job protocol: it posts, polls `/api/jobs/:id` (1 s, 10 min cap), downloads the PDF, and resolves to `{ok, pdf(base64), log, status, focus}`, reporting progress via an optional callback (shown in the status bar). A reply without a `jobId` is a validation failure and is returned as is. In `EditorPage.tsx`, `compile()` first saves a live collaborative document (so line numbers match what the server compiles), records the preview's scroll position *before any await*, and hands the focus to `PdfPreview` through refs. `PdfPreview` scrolls to it after the pages render unless the reader scrolled meanwhile, otherwise restores the reader's place by ratio (also across zoom changes). Pitfalls: the render effect's own cleanup empties the container before the next run reads it, so the position is tracked in a ref from scroll events; and the compile shortcut must be bound inside CodeMirror at `Prec.highest`, because `basicSetup`'s default keymap binds Mod-Enter to "insert blank line" and sits ahead of the editor's own keymap.

**Editor language support (`latex/`).** Highlighting, environment/command completion, the structural linter (unmatched `\begin`/`\end`, braces, deprecated commands), hover docs, auto-close and folding come from **`codemirror-lang-latex`, which is AGPL-3.0-or-later** (the Overleaf Lezer grammar). The repo has no LICENSE file yet: decide the project's licence before distributing or hosting this for others (replacing the package means a permissive grammar such as `@codemirror/legacy-modes` stex plus our own sources). Our own code is `projectIndex.ts`: it indexes labels, bib keys and file paths from *all* text files (`getAllFiles`, refreshed after tree changes and saves; the live document overlays its own labels) and powers completion inside `\ref{}`, `\cite{}`, `\includegraphics{}`, `\input{}`, `\bibliography{}`, plus a warning for `\ref`/`\cite` keys nothing in the project defines. The package's single-file reference checks are switched off because they would flag every cross-file reference. Browser tests: `e2e/latex-intelligence.spec.ts`.

### Design system (`design/`)

All UI is built from the shared design system, imported as `@design` (alias in `apps/frontend/vite.config.ts` + `paths` in `apps/frontend/tsconfig.json`). Read `design/README.md` before touching UI. When building UI, follow the living style guide at `design/reference/design-system.html`.
- `tokens.css`: colour (light + dark via `data-theme` on `<html>`), type, spacing, radius, motion tokens and `op-`-prefixed component classes. Loaded first in `src/main.tsx`, before `App.css` and page CSS. If React code and the reference disagree on tokens, `tokens.css` is the source of truth.
- `Icon.tsx` / `iconPaths.ts`: the only icon source (`<Icon name="…" />`). Add new glyphs to `iconPaths.ts`.
- `ui.tsx`: `Button`, `IconButton` (label required), `Badge`, `Tag`, `Avatar`, `Menu`/`MenuButton`, `Select`, `SegmentedControl`, `Modal`, `PanelHeader`, `EmptyState`, `FieldError` (shared inline validation message).
- `AppTopBar.tsx` (shared top bar on every screen; workspace switcher + account menu, with a guest variant), `Logo.tsx`, `theme.ts` (`useTheme`), `AuthScreen.tsx` (sign-in / create-account).
- `workspace.tsx`: the **contract** between the UI and whatever supplies accounts/workspaces: types (`Workspace`, `WorkspaceRole`, `AccountUser`, …), `WorkspaceContextValue`, `<WorkspaceProvider value={…}>`, `useWorkspace()`. It knows nothing about the API; `apps/frontend/src/auth` supplies the real value. Action methods are async and reject with a user-presentable `Error`; components must handle the rejection (see `MembersSection` in `ProjectPage.tsx`).

Rules when writing UI:
- Use tokens (`var(--surface)`, `var(--text-2)`, `var(--accent)`…), never hex/rgba literals.
- Use `design/` components instead of new button/dropdown/menu styles (the old `btn` / `ios-btn` / `ios-select` / `ios-dropdown` / `toolbar-btn` / `icon-btn` families were removed). Allow one primary button per region.
- Never use emoji, text glyphs (✕ ▾ ▸ −) or pasted inline SVGs for icons.
- New strings go through `t('English text')`, with a matching entry in `src/i18n/locales/zh-CN.json`. English falls back to the key.
- `app/App.css` holds remaining legacy page styles (already mapped onto tokens). New page-level styles go in a page stylesheet such as `app/pages.css` or `app/editor-shell.css`.

`design/reference/` also has `index.html` (clickable prototype of the workspace home + editor shell), sharing `openprism.css` and `icons.js`. Open these directly in a browser; they are standalone HTML, not part of the Vite build.

### Templates (`templates/`)

Built-in conference templates (ACL, CVPR, NeurIPS, ICML) registered in `templates/manifest.json` (id, label, mainFile, category, bilingual descriptions, tags). In the Django API, templates are `Template` rows with files in Garage; users upload custom ones as a ZIP via `POST /api/templates/upload`. `manage.py import_legacy` loads this directory into them, and `manifest.json` is no longer the source of truth.

### Kubernetes (`deploy/k8s`)

Kustomize: `base/` (api, web, worker-compile, worker-transfer, worker-ai, beat, migrate Job, PDBs, HPAs, ingress, default-deny NetworkPolicies), `overlays/local` (adds Postgres/Redis/Garage for a kind-style cluster), `overlays/production` (managed services, `CHANGE ME` placeholders), `components/keda` (queue-depth autoscaling). The compile/transfer/AI workers are separate Deployments of the same images with different `-Q` queues and shutdown grace periods above their task time limits (330 s / 1860 s / 960 s). `worker-compile` has no internet egress and no LLM credentials; `openprism-ai` is mounted only into `worker-transfer` and `worker-ai`. The k8s `README.md` lists prerequisites (an enforcing CNI, ingress, metrics-server), the security model, operating notes (DB connection math, `podPidsLimit`) and what is still unverified.

### Devcontainer

`.devcontainer/` builds a Node 20 image with TeX Live packages via apt, mounts `/home/node/.claude` as a named Docker volume (persisting Claude Code config), and adds the docker-in-docker feature. `postCreateCommand` chowns that volume to the `node` user before `npm install`: a fresh volume is created root-owned by Docker on first mount, which breaks any tool needing to write there.
