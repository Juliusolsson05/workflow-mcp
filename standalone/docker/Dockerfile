# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

# node:22.23.1-alpine3.23. Codex publishes musl-native binaries (including its sandbox resources)
# for both release architectures, so the compact Alpine runtime does not need a compatibility
# libc. A Debian base pulled Git's Perl/curl dependency fan-out into the credential-bearing final
# image and could not satisfy the unwaived HIGH scan threshold. The manifest-list digest still
# resolves native Node and Codex optional packages for each TARGETPLATFORM instead of copying
# BUILDPLATFORM node_modules.
ARG NODE_IMAGE=docker.io/library/node:22.23.1-alpine3.23@sha256:8516dce0483394d5708d4b2ee6cacb79fb1d617ea4e2787c2120bcca92ce372e

FROM ${NODE_IMAGE} AS build
ARG VERSION=0.1.0-dev
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
# WHY: every package in the compiler closure is exact-revision pinned. Pinning only the build-base
# meta-package would still let a later repository index select a different GCC or musl under the
# same Dockerfile. This stage is discarded, but its bytes produce shipped native helpers and are
# therefore just as much a part of release provenance as final-stage packages.
RUN apk add --no-cache \
      build-base=0.5-r3 binutils=2.45.1-r0 file=5.46-r2 fortify-headers=1.1-r5 \
      g++=15.2.0-r2 gcc=15.2.0-r2 gmp=6.3.0-r4 isl26=0.26-r1 jansson=2.14.1-r0 \
      libatomic=15.2.0-r2 libgomp=15.2.0-r2 libmagic=5.46-r2 libstdc++-dev=15.2.0-r2 \
      make=4.4.1-r3 mpc1=1.3.1-r1 mpfr4=4.2.2-r0 musl-dev=1.2.5-r23 \
      patch=2.8-r0 zstd-libs=1.5.7-r2
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
ARG VERSION=0.1.0-dev
ARG REVISION=development
ARG SOURCE=https://github.com/Juliusolsson05/workflow-mcp
LABEL org.opencontainers.image.title="Workflow MCP" \
      org.opencontainers.image.description="Docker-first durable workflow orchestration MCP server for Codex" \
      org.opencontainers.image.source=${SOURCE} \
      org.opencontainers.image.url="https://github.com/Juliusolsson05/workflow-mcp/tree/main/standalone" \
      org.opencontainers.image.documentation="https://github.com/Juliusolsson05/workflow-mcp/blob/main/standalone/README.md" \
      org.opencontainers.image.revision=${REVISION} \
      org.opencontainers.image.version=${VERSION} \
      org.opencontainers.image.licenses="MIT" \
      io.modelcontextprotocol.server.name="io.github.Juliusolsson05/workflow-mcp"

# WHY: direct pins are insufficient because APK may legally advance a dependency while keeping the
# requested Git revision available. Naming the complete added closure makes repository movement
# fail closed instead of silently changing a release retry; packages inherited from NODE_IMAGE are
# already frozen by its multi-architecture digest.
RUN apk add --no-cache \
      brotli-libs=1.2.0-r0 c-ares=1.34.8-r0 git=2.52.0-r0 \
      git-init-template=2.52.0-r0 libcurl=8.20.0-r0 libexpat=2.8.2-r0 \
      libidn2=2.3.8-r0 libpsl=0.21.5-r3 libunistring=1.4.1-r0 \
      nghttp2-libs=1.69.0-r0 pcre2=10.47-r0 ripgrep=15.1.0-r0 \
      tini=0.19.0-r3 zstd-libs=1.5.7-r2 \
    # WHY: the final process invokes only `node` and checked-in entrypoints. npm, npx, Corepack,
    # and Yarn are build-time package managers; retaining them would add an unused executable
    # surface plus their own tar/signature dependency graphs to the credential-bearing runtime.
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    && addgroup -g 10001 -S workflow \
    && adduser -S -D -H -u 10001 -G workflow -h /data/codex-home -s /bin/sh workflow \
    && git config --system --add safe.directory /workspace

WORKDIR /opt/workflow-mcp
COPY --from=runtime-dependencies /opt/workflow-mcp/node_modules ./node_modules
COPY --from=runtime-dependencies /opt/workflow-mcp/standalone/node_modules ./standalone/node_modules
COPY package.json package-lock.json README.md LICENSE ./
COPY standalone/package.json standalone/package-lock.json ./standalone/
COPY --from=build /build/dist ./dist
COPY --from=build /build/standalone/dist ./standalone/dist
# The image is the primary artifact, so it carries the exact renderer inputs for its checksummed
# host bundle. The digest itself cannot be embedded without a circular build; `bundle-render`
# accepts that externally known digest and release metadata, then release CI proves byte parity.
COPY standalone/compose.yaml standalone/compose.web.yaml standalone/compose.authoring.yaml \
  standalone/compose.auth-api-key.yaml standalone/compose.auth-host-codex.yaml \
  standalone/compose.hardened.yaml standalone/compose.project-codex-mask.yaml ./standalone/
COPY standalone/install/workflow-mcp-docker standalone/install/workflow-mcp-docker.ps1 \
  standalone/install/bundle.gitignore ./standalone/install/
COPY standalone/scripts/build-install-bundle.mjs standalone/scripts/launcher-smoke.sh standalone/scripts/stdio-session-smoke.mjs ./standalone/scripts/
COPY --from=native-build /native/workflow-mcp-lock /native/libworkflow_mcp_cloexec.so ./native/
COPY --chmod=0755 standalone/docker/entrypoint.sh /usr/local/bin/workflow-mcp
COPY --chmod=0755 standalone/docker/codex-isolated.sh ./bin/codex-isolated
COPY --chmod=0644 standalone/docker/codex-policy-launcher.mjs ./bin/codex-policy-launcher.mjs
COPY --chmod=0644 standalone/docker/codex-requirements.toml /etc/codex/requirements.toml

# Fresh named volumes use Docker copy-up from this tree. Normal startup never runs as root and must
# therefore begin with every durable domain privately owned by the fixed runtime identity.
# WHY: COPY fixes the requirements file mode but does not state the mode of an auto-created parent.
# Builder implementations and umasks must not decide whether runtime uid 10001 can traverse the
# administrator policy directory. Reassert the complete root-owned path contract in a RUN layer;
# otherwise Codex can report the world-readable file itself as EACCES on one builder only.
RUN chown 0:0 /etc/codex /etc/codex/requirements.toml \
    && chmod 0755 /etc/codex \
    && chmod 0644 /etc/codex/requirements.toml \
    && install -d -o 10001 -g 10001 -m 0700 \
      /data /data/.coordination /data/store /data/codex-home /data/config /data/secrets \
      /data/approvals /data/backups /data/workspaces /backup-output /bundle-output /run/workflow-mcp \
    && install -o 10001 -g 10001 -m 0600 /dev/null /data/.coordination/owner.lock \
    && install -d -o 10001 -g 10001 -m 0555 /workspace

ENV NODE_ENV=production \
    HOME=/data/codex-home \
    CODEX_HOME=/data/codex-home \
    WORKFLOW_MCP_DATA_DIR=/data \
    WORKFLOW_MCP_WORKSPACE=/workspace \
    WORKFLOW_MCP_CODEX_PATH=/opt/workflow-mcp/bin/codex-isolated \
    WORKFLOW_MCP_PORT=7331
USER 10001:10001
EXPOSE 7331
# Health is a daemon-mode concept and remains in Compose. A global image healthcheck would mark the
# default OCI STDIO server unhealthy because that compatibility mode intentionally opens no HTTP
# readiness port.
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/workflow-mcp"]
CMD ["serve", "--stdio", "/workspace"]
