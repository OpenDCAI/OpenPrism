# Doing Now

## v0.0.3.1 - Build fixes

- [ ] **#20 Web image build fails: `.dockerignore` excludes `apps/api/VERSION`.** Add `!apps/api/VERSION` so
      `docker compose build web` works again and the `:8080` image shows the current version.
