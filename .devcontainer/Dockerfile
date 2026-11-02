FROM mcr.microsoft.com/devcontainers/javascript-node:1-20-bookworm

USER root

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    git \
    latexmk \
    texlive-latex-recommended \
    texlive-latex-extra \
    texlive-fonts-recommended \
    texlive-science \
    texlive-xetex \
    texlive-luatex \
    wget \
    xvfb \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

RUN mkdir -p -m 755 /etc/apt/keyrings \
    && wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg > /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Browsers for the Playwright e2e specs and for QA in a real browser: Playwright's Chromium plus Google Chrome stable
# (`E2E_BROWSER=chrome`), with their system libraries. They live outside any home directory so a rebuild brings them
# back and the `node` user can read them. Keep PLAYWRIGHT_VERSION equal to @playwright/test in apps/frontend (the
# browser build is tied to the Playwright version). Chrome stable has no arm64 Linux build, so it is amd64-only.
ARG PLAYWRIGHT_VERSION=1.55.0
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN BROWSERS="chromium"; [ "$(dpkg --print-architecture)" = "amd64" ] && BROWSERS="chromium chrome"; \
    npx --yes playwright@${PLAYWRIGHT_VERSION} install --with-deps $BROWSERS \
    && chmod -R a+rX /ms-playwright \
    && apt-get clean && rm -rf /var/lib/apt/lists/* /root/.npm

USER node

# Install the Claude Code CLI via the official bash installer (not npm).
# Runs as the `node` user so it lands in /home/node/.local/bin.
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/home/node/.local/bin:${PATH}"
