# Doing Now

## v0.0.1.1 - QA tooling

- [ ] #10 **Playwright, Chromium and Chrome in the devcontainer.** Bake Playwright (pinned to the repo's version),
      Chromium and Google Chrome stable into `.devcontainer/Dockerfile`; add a root `e2e` script; `E2E_BROWSER=chrome`
      selects Chrome; update the docs; make it work in the running container too.
- [ ] #11 **API tests delete the built-in templates' files from the dev bucket.** `BuiltinTemplateTests` (from #8)
      imports the real templates and the shared cleanup clears their storage. Keep the real templates' files; add a guard.
