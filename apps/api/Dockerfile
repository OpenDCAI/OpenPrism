# Stages: `api` (also used by beat), `tex` (adds TeX Live for compile workers) and `ai` (adds matplotlib/pandas for plots).
FROM python:3.12-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
RUN useradd --create-home app && chown -R app /app


# Tectonic and its offline package bundle, in a stage of their own so that code changes do not download 3 GB again.
# Compile workers have no internet access, so tectonic reads every package from the bundle directory and never fetches.
FROM debian:trixie-slim AS tectonic
ARG TECTONIC_VERSION=0.17.0
ARG TECTONIC_SHA256=8533d07f9ccbd7a65824b9e0459041bca34af1eb33daba48f59215593753a3b7
# TeX Live 2022 packages: where tectonic's default bundle URL (relay.fullyjustified.net/default_bundle_v33.tar) leads.
ARG TECTONIC_BUNDLE_URL=https://data1b.fullyjustified.net/tlextras-2022.0r0.tar
ARG TECTONIC_BUNDLE_SHA256=425685e124746c15ba9bb8e0596bdaad98fce886afa347fbcf9ec0e9acd7fe79
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && apt-get clean && rm -rf /var/lib/apt/lists/*
RUN set -eu; mkdir -p /opt/tectonic/bin; \
    curl -fsSL -o /tmp/tectonic.tar.gz "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}/tectonic-${TECTONIC_VERSION}-x86_64-unknown-linux-musl.tar.gz"; \
    echo "${TECTONIC_SHA256}  /tmp/tectonic.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/tectonic.tar.gz -C /opt/tectonic/bin tectonic; rm /tmp/tectonic.tar.gz
RUN set -eu; mkdir -p /opt/tectonic/bundle; \
    curl -fsSL -o /tmp/bundle.tar "${TECTONIC_BUNDLE_URL}"; \
    echo "${TECTONIC_BUNDLE_SHA256}  /tmp/bundle.tar" | sha256sum -c -; \
    tar -xf /tmp/bundle.tar -C /opt/tectonic/bundle --no-same-owner; rm /tmp/bundle.tar; \
    chmod -R a+rX,go-w /opt/tectonic/bundle
# Build the LaTeX format once here: compiles then start at once, and the cache can stay read-only at run time.
RUN set -eu; cd /tmp; printf '\\documentclass{article}\\begin{document}x\\end{document}\n' > warm.tex; \
    TECTONIC_CACHE_DIR=/opt/tectonic/cache /opt/tectonic/bin/tectonic --untrusted --bundle /opt/tectonic/bundle warm.tex; \
    rm warm.*; chmod -R a+rX,go-w /opt/tectonic/cache


FROM base AS tex
USER root
COPY --from=tectonic /opt/tectonic /opt/tectonic
RUN apt-get update && apt-get install -y --no-install-recommends \
    latexmk biber \
    texlive-latex-recommended texlive-latex-extra texlive-fonts-recommended \
    texlive-science texlive-xetex texlive-luatex texlive-bibtex-extra \
    texlive-publishers texlive-plain-generic texlive-fonts-extra \
    && apt-get clean && rm -rf /var/lib/apt/lists/*
USER app
CMD ["celery", "-A", "config", "worker", "-Q", "compile,transfer", "-l", "info", "--concurrency", "2"]


FROM base AS ai
USER root
COPY requirements-ai.txt .
RUN pip install --no-cache-dir -r requirements-ai.txt
USER app
CMD ["celery", "-A", "config", "worker", "-Q", "ai,import", "-l", "info", "--concurrency", "4"]


FROM base AS api
USER app
EXPOSE 8000
CMD ["uvicorn", "config.asgi:application", "--host", "0.0.0.0", "--port", "8000"]
