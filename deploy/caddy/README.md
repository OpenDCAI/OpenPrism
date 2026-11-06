# Caddy2 configuration for OpenPrism

`openprism.Caddyfile` is the site block for the cluster's external Caddy2. It is a reference: nothing in this repo applies
it, so whoever runs Caddy adds it (paste the block into the main Caddyfile, or `import` this file) and reloads.

```
browser --TLS--> Caddy --> any node :31081 (NodePort) --> Service web (nginx) --/api--> Service api (uvicorn)
```

## Before you use it

1. **Hostname.** `openprism.cent-su.org` is a placeholder, like `graderthan.cent-su.org` and `portal.app.cent-su.org` for
   the other apps. It must equal `host:` in `deploy/helm/openprism/values.yaml` (and `PUBLIC_URL` in
   `.github/workflows/deploy-cent-k8s.yaml`): the app builds its links and allowed hosts from it.
2. **Node addresses.** `10.0.0.11` and `10.0.0.12` are placeholders. `kubectl get nodes -o wide` lists the real ones; every
   node serves the NodePort, so list two or more, and make sure Caddy's host can reach them on that port.
3. **NodePort.** The chart uses **31081**. Known allocations on this cluster: 31080 iot-portal, 31801 graderthan. Check
   the rest before deploying: `kubectl get svc -A -o wide | grep NodePort`. Change `nodePort` in the chart values and
   the two upstream addresses together.

## What each setting is for (all exercised against a real Caddy 2.11, see below)

| Setting | Why |
|---|---|
| `request_body { max_size 200MB }` | the app accepts 200 MB uploads (`MAX_UPLOAD_BYTES`); bigger bodies get 413 at the proxy |
| `flush_interval -1` | arXiv import streams progress as server-sent events and live editing uses websockets (`/api/collab`); neither may be buffered |
| `read_timeout` / `write_timeout` 1h | long jobs hold a connection with few bytes in flight; the web nginx allows an hour as well |
| `health_uri /healthz` | nginx's own health endpoint; a node that stops answering leaves rotation |
| `stream_close_delay 5m` | a Caddy config reload does not drop every live-editing websocket at once |
| `log { ... delete token }` | short-lived URL tokens travel in `?token=` (images, PDFs, event streams, websockets); they must not reach the access log |
| `Strict-Transport-Security` | transport security; nginx already sets `Referrer-Policy` and `X-Content-Type-Options` |

**Forwarded headers.** Caddy sets `X-Forwarded-For`, `-Proto` and `-Host` itself and *replaces* any the client sent (a
spoofed `X-Forwarded-For` does not survive). The app counts two proxies in front of it, this one and the web nginx
(`trustedProxyCount: 2`), and `DJANGO_BEHIND_TLS_PROXY=1` trusts `X-Forwarded-Proto` for HTTPS. If another proxy is ever
put in front of Caddy, raise `trustedProxyCount` by one.

## Checking it

```bash
caddy validate --config deploy/caddy/openprism.Caddyfile          # or: docker run --rm -v "$PWD/deploy/caddy:/c:ro" caddy:2-alpine caddy validate --config /c/openprism.Caddyfile
curl -fsS https://openprism.cent-su.org/api/health                # {"ok": true, "version": "..."}
deploy/smoke-release.sh https://openprism.cent-su.org <version>   # what the deploy workflow runs last
```

Tested so far with a stand-in upstream (same file, only the site address and upstream swapped): the file validates;
a 150 MB upload passes and 210 MB gets 413; `?token=` is absent from the log while other query parameters stay; client
`X-Forwarded-For` is replaced; headers of an event stream reach the client at once; a stopped upstream gives 503 and
recovers when it returns. **Not yet tested:** websockets (`/api/collab`) and the real cluster. After the first deploy,
check in the app: sign in over HTTPS, open one file in two browsers and type in both, import from arXiv and watch the
progress stream, upload a large ZIP, and confirm no `token=` appears in Caddy's log.
