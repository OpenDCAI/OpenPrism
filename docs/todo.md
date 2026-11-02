# Doing Now

## v0.0.2 - Zotero

Decisions: the Zotero API key is stored server-side, encrypted (shared design with v0.0.3 workspace LLM keys); cite keys are
Zotero's own; no managed `.bib` file, adding a reference only appends missing entries.

- [ ] #12 **Encrypted per-user key store and connect/disconnect API.** `CREDENTIAL_ENCRYPTION_KEY` (rotatable Fernet),
      `integrations.ZoteroConnection`, `PUT/GET/DELETE /api/integrations/zotero`, key never returned or logged.
- [ ] #13 **Zotero client and browse API.** Libraries (personal + groups), collections, paged item search; honours
      `Backoff`/`Retry-After`; library allow-list.
- [ ] #14 **BibTeX export and append-only add to the project `.bib`.** Skips existing keys, generated-key fallback,
      sanitises untrusted BibTeX, flushes live collab rooms first.
- [ ] #15 **Editor panel to search and insert citations.** Connect screen, Zotero panel, `\cite{}` insertion, Playwright spec.
