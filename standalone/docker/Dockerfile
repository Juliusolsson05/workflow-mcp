# syntax=docker/dockerfile:1.7

# node:22.17.1-bookworm-slim. The manifest-list digest intentionally resolves a native Node and
# Codex optional package for each TARGETPLATFORM instead of copying BUILDPLATFORM node_modules.
ARG NODE_IMAGE=docker.io/library/node:22.17.1-bookworm-slim@sha256:2fa754a9ba4d7adbd2a51d182eaabbe355c82b673624035a38c0d42b08724854

FROM ${NODE_IMAGE} AS build
ARG VERSION=0.0.0
ARG REVISION=development
ENV WORKFLOW_MCP_BUILD_VERSION=${VERSION} \
    WORKFLOW_MCP_BUILD_REVISION=${REVISION}
WORKDIR /build
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --include=dev
COPY scripts/clean-dist.mjs scripts/generate-build-metadata.mjs ./scripts/
COPY src ./src
RUN npm run build

COPY standalone/package.json standalone/package-lock.json standalone/tsconfig.json standalone/tsconfig.web.json ./standalone/
RUN npm --prefix standalone ci --include=dev
COPY standalone/scripts ./standalone/scripts
COPY standalone/src ./standalone/src
COPY standalone/web ./standalone/web
RUN npm --prefix standalone run build \
    && find /build/dist /build/standalone/dist -type f \
      \( -name '*.map' -o -name '*.d.ts' \) -delete

FROM ${NODE_IMAGE} AS native-build
RUN apt-get update \
    && apt-get install --yes --no-install-recommends gcc libc6-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /native
COPY standalone/docker/workflow-mcp-lock.c standalone/docker/workflow-mcp-cloexec.c ./
RUN gcc -std=c11 -O2 -Wall -Wextra -Werror -o workflow-mcp-lock workflow-mcp-lock.c \
    && gcc -std=c11 -O2 -Wall -Wextra -Werror -fPIC -shared \
      -o libworkflow_mcp_cloexec.so workflow-mcp-cloexec.c

# This stage deliberately runs for TARGETPLATFORM. @openai/codex uses architecture-specific
# optional dependencies, so a fast cross-build must use emulation or a native builder rather than
# smuggling the build host's binary into the final manifest member.
FROM ${NODE_IMAGE} AS runtime-dependencies
WORKDIR /opt/workflow-mcp
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force
COPY standalone/package.json standalone/package-lock.json ./standalone/
RUN npm --prefix standalone ci --omit=dev \
    && npm cache clean --force

FROM ${NODE_IMAGE} AS runtime
ARG VERSION=0.0.0
ARG REVISION=development
ARG SOURCE=https://github.com/Juliusolsson05/workflow-mcp
LABEL org.opencontainers.image.title="Workflow MCP" \
      org.opencontainers.image.description="Docker-first durable workflow orchestration MCP server for Codex" \
      org.opencontainers.image.source=${SOURCE} \
      org.opencontainers.image.revision=${REVISION} \
      org.opencontainers.image.version=${VERSION} \
      org.opencontainers.image.licenses="MIT" \
      io.modelcontextprotocol.server.name="io.github.juliusolsson05/workflow-mcp"

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
      bubblewrap ca-certificates git ripgrep tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 workflow \
    && useradd --uid 10001 --gid 10001 --home-dir /data/codex-home --no-create-home \
      --shell /bin/sh workflow \
    && git config --system --add safe.directory /workspace

WORKDIR /opt/workflow-mcp
COPY --from=runtime-dependencies /opt/workflow-mcp/node_modules ./node_modules
COPY --from=runtime-dependencies /opt/workflow-mcp/standalone/node_modules ./standalone/node_modules
COPY package.json package-lock.json README.md LICENSE ./
COPY standalone/package.json standalone/package-lock.json ./standalone/
COPY --from=build /build/dist ./dist
COPY --from=build /build/standalone/dist ./standalone/dist
COPY --from=native-build /native/workflow-mcp-lock /native/libworkflow_mcp_cloexec.so ./native/
COPY --chmod=0755 standalone/docker/entrypoint.sh /usr/local/bin/workflow-mcp
COPY --chmod=0755 standalone/docker/codex-isolated.sh ./bin/codex-isolated

# Fresh named volumes use Docker copy-up from this tree. Normal startup never runs as root and must
# therefore begin with every durable domain privately owned by the fixed runtime identity.
RUN install -d -o 10001 -g 10001 -m 0700 \
      /data /data/.coordination /data/store /data/codex-home /data/config /data/secrets \
      /data/approvals /data/backups /data/workspaces /run/workflow-mcp \
    && install -o 10001 -g 10001 -m 0600 /dev/null /data/.coordination/owner.lock \
    && install -d -o 10001 -g 10001 -m 0555 /workspace

ENV NODE_ENV=production \
    HOME=/data/codex-home \
    CODEX_HOME=/data/codex-home \
    WORKFLOW_MCP_DATA_DIR=/data \
    WORKFLOW_MCP_WORKSPACE=/workspace \
    WORKFLOW_MCP_CODEX_PATH=/opt/workflow-mcp/bin/codex-isolated \
    WORKFLOW_MCP_CODEX_CONFIG_FINGERPRINT=86961f614605863487ba92a70f608cd6f0002a64aaeff44e3c05aa7c1eda0e3a \
    WORKFLOW_MCP_PORT=7331
USER 10001:10001
EXPOSE 7331
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=6 \
  CMD ["workflow-mcp", "healthcheck"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/workflow-mcp"]
CMD ["serve", "--stdio", "/workspace"]
