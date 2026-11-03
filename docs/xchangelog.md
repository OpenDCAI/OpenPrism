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
