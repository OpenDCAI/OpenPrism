# OpenPrism2

A local-first LaTeX + AI workspace for academic writing: a three-panel web app (file tree / LaTeX editor / PDF preview) with an LLM assistant, LaTeX compilation, conference-template management and transfer, real-time multi-user editing, and peer-review tooling.

This is a reboot of OpenPrism. Project north-star goals:

1. **Make a LaTeX editor for those not comfortable with LaTeX.** AI should help with LaTeX and match user intent to LaTeX output. For example "I need a table of contents here.", or "cite". There should be a keystroke to invoke AI within the editor. Switch templates with ease.

2. **Everything needed to manage the work of working together.** People can review papers, edit together in real-time, track each other's changes, revert changes, leave notes and to-dos.

3. **Research assistant in a box.** Help with research activity like finding sources, similar papers, validating citations (appropriate to argument), rewriting sections, suggesting ways to shorten papers, Zotero integration.

## Architecture

OpenPrism is a set of containers, orchestrated locally by Docker Compose and in production by Kubernetes (`deploy/k8s`).

| Component | Tech | Role |
|---|---|---|
| `web` | nginx + built React SPA | Serves the frontend; proxies `/api` (including websockets and SSE) to the API |
| `api` | Django + DRF + Channels (uvicorn) | Stateless REST API and the real-time collaboration websocket (`/api/collab`) |
| `worker-tex` | Celery (queues `compile`, `transfer`) | LaTeX compilation (TeX Live) and template transfer |
| `worker-ai` | Celery (queues `ai`, `import`) | LLM calls, agent, plots, arXiv import |
| `beat` | Celery beat | Housekeeping: reaps dead jobs, deletes old ones |
| `postgres` | PostgreSQL | Accounts, workspaces, projects, text files, job state |
| `redis` | Redis | Celery broker, collaboration fan-out, short-lived job secrets |
| `garage` | Garage (S3-compatible) | Binary project files, templates, compiled PDFs |

Long operations (compile, AI, template transfer, arXiv import) are `Job` rows processed by Celery workers; the frontend polls `/api/jobs/:id`. Real-time editing uses Yjs (CRDT) synced through the API and Redis. LLM keys entered in the UI are sent per request and never stored in the database.

Repository layout:

```
apps/frontend/   React 18 + TypeScript + Vite single-page app
apps/api/        Django project (accounts, projects, templates_app, jobs, ai, transfer, collab)
design/          Shared UI design system, imported by the frontend as @design
deploy/          Garage bootstrap script and Kubernetes manifests (deploy/k8s)
templates/       Built-in conference templates (ACL, CVPR, NeurIPS, ICML)
compose.yaml     Local stack definition
```

See `CLAUDE.md` for detailed design notes and `deploy/k8s/README.md` for Kubernetes (the manifests have not yet been applied to a real cluster).

## Running locally

### Prerequisites

- Docker with Docker Compose v2
- Node.js 20+ and npm (for the dev server)
- Optional: open the repo in the provided **devcontainer** (`.devcontainer/`), which has Node 20, TeX Live, and docker-in-docker already set up.

You do **not** need a local TeX install or Python; LaTeX runs in the `worker-tex` image and Django in the `api` image.

### Steps

```bash
# 1. Configure (once). The defaults are dev-only placeholders.
cp .env.sample .env
#    Optional: set OPENPRISM_LLM_ENDPOINT / OPENPRISM_LLM_API_KEY / OPENPRISM_LLM_MODEL
#    (and OPENPRISM_MINERU_TOKEN) for server-side AI defaults. You can also enter
#    these per browser in the app's settings instead.

# 2. Start the backend stack: postgres, redis, garage, api, workers, beat, web
docker compose up -d --wait

# 3. One-time (idempotent): create the Garage layout, bucket and access key
deploy/garage-init.sh

# 4. Install frontend dependencies and start the dev server
npm install
npm run dev
```

Then open:

- **http://localhost:5173**: dev server with hot reload (proxies `/api` to the API on :8000)
- **http://localhost:8080**: the production-style `web` image (built SPA + nginx)

There is no seeded user: click **Create account** in the UI to register. Registering creates your personal workspace.

| Port | Service |
|---|---|
| 5173 | Vite dev server |
| 8080 | nginx `web` image |
| 8000 | Django API |
| 5432 / 6379 / 3900 | Postgres / Redis / Garage S3 |

### Health checks

```bash
curl localhost:8000/healthz   # API liveness
curl localhost:8000/readyz    # API + Postgres + Redis + S3 (503 if any is down)
curl localhost:8080/healthz   # web
```

### Everyday commands

```bash
docker compose logs -f api worker-tex        # follow logs
docker compose restart worker-tex worker-ai beat   # after editing task code (Celery doesn't auto-reload; the api does)
docker compose up -d                         # recreate containers after rebuilding images
docker compose down                          # stop everything, keep data
docker compose down -v                       # stop and wipe all data
```

After changing Django models: `docker compose run --rm api python manage.py makemigrations <app>` and commit the migration.

### Importing the pre-migration data

Earlier versions kept templates and projects on disk. To load `templates/` and `data/` into an account (register it first):

```bash
docker compose exec api python manage.py import_legacy --owner you@example.com
```

### Tests

Backend tests use the real Postgres/Redis/Garage; run `deploy/garage-init.sh` once first and always pass `--noinput`:

```bash
docker compose run --rm api python manage.py test --noinput
docker compose run --rm worker-tex python manage.py test jobs transfer --noinput   # real pdflatex/bibtex
docker compose run --rm worker-ai python manage.py test ai --noinput               # real matplotlib + plot sandbox
```

Browser tests (Playwright), with the stack and `npm run dev` running:

```bash
npx playwright install chromium && sudo npx playwright install-deps chromium   # one-time
npm --workspace apps/frontend run e2e                                 # E2E_BASE_URL=http://localhost:8080 to test the nginx image
```

## Configuration

Everything is environment variables in `.env` (see `.env.sample` for the full list). Key ones:

- `DJANGO_SECRET_KEY`: **required**; startup fails without it.
- `DATABASE_URL`, `REDIS_URL`, `S3_*`: data service connections. Compose supplies container-side hostnames itself.
- `OPENPRISM_LLM_*`: optional server-side LLM defaults; `LLM_ALLOW_PRIVATE_ENDPOINTS=1` lets the AI worker call a local model (dev only).
- `OPENPRISM_MINERU_*`: PDF-to-Markdown for template transfer.

The values in `.env.sample` (all-zero Garage secrets, `dev-insecure-change-me`) are for local development only. Never reuse them on a shared deployment.

## Deployment

Kubernetes manifests (Kustomize) live in `deploy/k8s`. They have been rendered and statically checked but **not applied to a cluster yet**; read `deploy/k8s/README.md` before relying on them.
