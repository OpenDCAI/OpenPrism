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
| v0.0.4.1 | [v0.0.4.1-version-history-follow-ups.md](v0.0.4.1-version-history-follow-ups.md) | Single-file restore, failed compiles as versions, storage report and retention, visual PDF comparison |
| v0.0.5 | [v0.0.5-ask-ai.md](v0.0.5-ask-ai.md) | Ask AI in place (Ctrl/Cmd+K) |
| v0.0.6 | [v0.0.6-accounts-and-comments.md](v0.0.6-accounts-and-comments.md) | Mail, password reset/change, delete account, email verification, invitation mail, invite-link roles, comments |
| v0.0.7 | [v0.0.7-tectonic-and-transfer-cleanup.md](v0.0.7-tectonic-and-transfer-cleanup.md) | Tectonic compiles offline; a failed template transfer removes its project |
| v0.0.8 | [v0.0.8-security.md](v0.0.8-security.md) | Session cookie, scoped URL tokens, AI keys on the server, limits and usage, credential history, AI polling, direct uploads |
| v0.0.9 | [v0.0.9-collaboration.md](v0.0.9-collaboration.md) | Uploads/saves/templates reach open editors; renaming or deleting an open file; crash-safe live editing, expiring cursors |
| v0.0.10 | [v0.0.10-testing.md](v0.0.10-testing.md) | JWT clock leeway, clean typecheck, lean production images, new browser specs, CI |

## Before you start

1. Start the stack and the dev server (see `README.md`): `docker compose up -d --wait`, `deploy/garage-init.sh` once,
   `npm run dev`.
2. Check the version: `curl localhost:8000/healthz` returns the release you are testing (note: v0.0.4.1 was released after v0.0.7, so versions are not in release order), and the account menu shows the
   same version at the bottom.
3. Load the built-in templates once into an account: register it in the UI, then
   `docker compose exec api python manage.py import_legacy --owner you@example.com`.
4. Use http://localhost:5173 (dev server) for the scripts. Repeat a release's smoke steps on http://localhost:8080 (the
   production `web` image, rebuilt with `docker compose build web && docker compose up -d`) before tagging.
5. From v0.0.6 the app sends mail; in development it all lands in Mailpit at http://localhost:8025.
6. Several scripts need **two people**. Use a second browser profile or a private window, so the two sessions do not
   share local storage. Some need a **second account** in the same team workspace with a chosen role (Editor, Viewer).
7. Keep the browser's developer console open: any red error during a script is a finding.

## Accounts used in the scripts

| Name in the scripts | How to make it |
|---|---|
| **Owner** | Register in the UI. Owns a team workspace: Workspace switcher → create a workspace (e.g. "QA Lab"). |
| **Editor** | Register a second account; Owner invites its email with role Editor (workspace Members). |
| **Viewer** | Register a third account; Owner invites it with role Viewer. |
| **Commenter** | (v0.0.6) Another account invited with role Commenter. |
| **Guest** | No account: Owner creates an invite link in the editor's Collaboration panel and opens it in a private window. |

## Recording results

Copy the script into the release's issue or a scratch file, tick each step, and for any failure write: what you did, what you
expected, what happened, a screenshot, and the browser. File new bugs as GitHub issues (label `QA`, plus a priority and type; see CLAUDE.md).
