# Manual QA scripts

One script per release, written for a person clicking through the app. Each step has an expected result; tick it or note what
happened. The automated Playwright specs cover most of this (named at the top of each script), so these scripts are for
release sign-off, a look at a real deployment, and anything a spec cannot judge (layout, wording, a real LLM or Zotero).

| Release | Script | Feature |
|---|---|---|
| v0.0.1 | [v0.0.1-templates.md](v0.0.1-templates.md) | Built-in and uploaded templates compile; template transfer layout check |
| v0.0.1.1 | [v0.0.1.1-qa-tooling.md](v0.0.1.1-qa-tooling.md) | Playwright, Chromium and Chrome in the devcontainer |
| v0.0.2 | [v0.0.2-zotero.md](v0.0.2-zotero.md) | Zotero: connect, search, cite, add to the bibliography |
| v0.0.3 / v0.0.3.1 | [v0.0.3-workspace-ai-provider.md](v0.0.3-workspace-ai-provider.md) | Workspace AI provider; web image build fix |
| v0.0.4 | [v0.0.4-version-history.md](v0.0.4-version-history.md) | Version history: save, view, name, delete, compare, restore |
| v0.0.5 | [v0.0.5-ask-ai.md](v0.0.5-ask-ai.md) | Ask AI in place (Ctrl/Cmd+K) |

## Before you start

1. Start the stack and the dev server (see `README.md`): `docker compose up -d --wait`, `deploy/garage-init.sh` once,
   `npm run dev`.
2. Check the version: `curl localhost:8000/healthz` returns the release you are testing, and the account menu shows the
   same version at the bottom.
3. Load the built-in templates once into an account: register it in the UI, then
   `docker compose exec api python manage.py import_legacy --owner you@example.com`.
4. Use http://localhost:5173 (dev server) for the scripts. Repeat a release's smoke steps on http://localhost:8080 (the
   production `web` image, rebuilt with `docker compose build web && docker compose up -d`) before tagging.
5. Several scripts need **two people**. Use a second browser profile or a private window, so the two sessions do not
   share local storage. Some need a **second account** in the same team workspace with a chosen role (Editor, Viewer).
6. Keep the browser's developer console open: any red error during a script is a finding.

## Accounts used in the scripts

| Name in the scripts | How to make it |
|---|---|
| **Owner** | Register in the UI. Owns a team workspace: Workspace switcher → create a workspace (e.g. "QA Lab"). |
| **Editor** | Register a second account; Owner invites its email with role Editor (workspace Members). |
| **Viewer** | Register a third account; Owner invites it with role Viewer. |
| **Guest** | No account: Owner creates an invite link in the editor's Collaboration panel and opens it in a private window. |

## Recording results

Copy the script into the release's issue or a scratch file, tick each step, and for any failure write: what you did, what you
expected, what happened, a screenshot, and the browser. New bugs go on `docs/backlog.md` (see CLAUDE.md).
