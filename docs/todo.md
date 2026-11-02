# Doing Now

## v0.0.3 - Workspace LLM Keys

Decisions: workspace keys are stored on the back end, encrypted with the same mechanism as Zotero keys. Resolution
order: workspace key (members with a write role), else the user's browser key, else the server default. Set by
owners/admins only. No "mandatory" switch yet (the workspace key already wins whenever it is set). Audit trail goes to
the backlog (v0.0.8).

- [ ] #16 **Encrypted storage and management API.** `WorkspaceLlmConfig`, `GET/PUT/DELETE /api/workspaces/:id/llm`,
      masking, SSRF check on the endpoint.
- [ ] #17 **Use it for the AI endpoints and template transfer.** Resolution order, `/api/llm` takes `projectId`, key
      only travels as task argument / Redis job secret.
- [ ] #18 **Admin settings section in the workspace.** Configure, rotate, remove; members see a read-only status.
- [ ] #19 **Editor notice and `projectId` for `/api/llm`.**
