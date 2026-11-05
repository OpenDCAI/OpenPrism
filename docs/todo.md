# Doing Now

## v0.0.8 - Security issues

- [ ] #48 **Rate limits** on expensive endpoints, a policy and daily quota for the server-side LLM key, workspace usage limits.
- [ ] #49 **Audit log for stored credentials** (workspace LLM providers, Zotero, users' own keys).
- [ ] #50 **Users' own LLM/MinerU keys stored encrypted on the server** instead of plain-text localStorage.
- [ ] #51 **Short-lived, scoped URL tokens** instead of the full credential in `?token=`.
- [ ] #52 **Refresh token in an httpOnly cookie**, access token in memory only.
- [ ] #53 **Presigned direct-to-S3 uploads** for binary project files.
