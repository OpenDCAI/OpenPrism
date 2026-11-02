# Production web image: builds the SPA, serves it with nginx and proxies /api (incl. websockets) to the Django api.
# Build from the repo root (the frontend imports the shared /design package):
#   docker build -f apps/frontend/Dockerfile -t openprism-web .
FROM node:20-bookworm-slim AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/frontend/package.json apps/frontend/
RUN npm ci --workspace apps/frontend --include-workspace-root
COPY design design
COPY apps/frontend apps/frontend
COPY apps/api/VERSION apps/api/VERSION
RUN npm --workspace apps/frontend run build

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY apps/frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/frontend/dist /usr/share/nginx/html
EXPOSE 8080
