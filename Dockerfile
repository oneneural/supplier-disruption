# One application image: Next.js web, Fastify API and the pg-boss worker,
# supervised by s6-overlay as a fixed non-root user. PostgreSQL runs separately.
# Build natively for the host platform: docker compose build app

# node:24.22.0-bookworm-slim and alpine:3.22, multi-platform index digests resolved 2026-10-18.
ARG NODE_IMAGE=node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
ARG ALPINE_IMAGE=alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8

# Pinned Node with pnpm 12.14.0 (package.json packageManager) through Corepack.
FROM ${NODE_IMAGE} AS base
ENV COREPACK_HOME=/opt/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /src
COPY package.json ./
RUN corepack pnpm --version

# Frozen install from the lockfile. Manifests only, so source edits keep this layer.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN corepack pnpm fetch
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/domain/package.json packages/domain/
COPY packages/agent/package.json packages/agent/
COPY packages/db/package.json packages/db/
RUN corepack pnpm install --offline --frozen-lockfile

# The root "build" script's two steps, run through Corepack: the image has no
# pnpm on PATH for the script's nested call.
FROM deps AS build
COPY . .
RUN corepack pnpm exec tsc -b \
 && corepack pnpm --filter @supplier-disruption/web build

# Runtime artifacts only: Next standalone (repository-root tracing) with its
# public and static files beside the emitted app, and production-only
# deployments of the API (including compiled migrations and the seed) and worker.
# Deploy derives each lockfile from the workspace lockfile; its supply-chain
# policy check reads registry metadata, which "fetch" does not cache.
FROM build AS package
RUN corepack pnpm --filter @supplier-disruption/api deploy --prod /out/api \
 && corepack pnpm --filter @supplier-disruption/worker deploy --prod /out/worker \
 && mkdir -p /out/web \
 && cp -a apps/web/.next/standalone/. /out/web/ \
 && cp -a apps/web/.next/static /out/web/apps/web/.next/static \
 && cp -a apps/web/public /out/web/apps/web/public

# s6-overlay archives, verified against the SHA-256 values published with the
# release, then unpacked with busybox (the Node slim image has no xz).
FROM ${ALPINE_IMAGE} AS s6
ARG S6_OVERLAY_VERSION=3.2.3.2
ARG TARGETARCH
ADD --checksum=sha256:5379750ed30a84bbd2e2dd74847ba6b5bd29cd0b2e3ea2ec58049b57eb2eda12 \
    https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz /tmp/
ADD --checksum=sha256:b17f17a82e7a515c682a91edaf2ffdabb73f891981b6c1fd712115693a2f8b4c \
    https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-aarch64.tar.xz /tmp/
ADD --checksum=sha256:e6befcc96a437a3831386ecfc51808c5d3e939dc5fe3c02ae9284599e8aa2408 \
    https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-x86_64.tar.xz /tmp/
RUN case "$TARGETARCH" in \
      arm64) arch=aarch64 ;; \
      amd64) arch=x86_64 ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && mkdir /s6root \
 && tar -C /s6root -Jxpf /tmp/s6-overlay-noarch.tar.xz \
 && tar -C /s6root -Jxpf "/tmp/s6-overlay-$arch.tar.xz"

FROM ${NODE_IMAGE} AS runtime
ARG BUILD_REVISION=unknown
LABEL org.opencontainers.image.title="supplier-disruption-app" \
      org.opencontainers.image.revision="${BUILD_REVISION}"
# NODE_ENV=production also makes BOOT_ID_FILE mandatory, so no service in the
# image falls back to a self-generated boot ID. S6_CMD_WAIT_FOR_SERVICES_MAXTIME
# bounds s6-rc's start transition 10 s past the watchdog's 90 s startup bound:
# a halt requested while that transition waits for API readiness can only run
# once it ends (ADR 0002).
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    BUILD_REVISION=${BUILD_REVISION} \
    PATH=/command:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    S6_READ_ONLY_ROOT=1 \
    S6_BEHAVIOUR_IF_STAGE2_FAILS=2 \
    S6_LOGGING=0 \
    S6_KILL_GRACETIME=5000 \
    S6_KEEP_ENV=0 \
    S6_CMD_WAIT_FOR_SERVICES_MAXTIME=100000
# Fixed non-root identity. /var/run must already point at /run, because the
# read-only root filesystem leaves s6 unable to fix it at start.
RUN groupadd --gid 10001 sd \
 && useradd --uid 10001 --gid 10001 --home-dir /home/sd --create-home --shell /usr/sbin/nologin sd \
 && rm -rf /var/run \
 && ln -s /run /var/run
COPY --from=s6 /s6root/ /
COPY --from=package /out/api /opt/api
COPY --from=package /out/worker /opt/worker
COPY --from=package /out/web /opt/web
COPY infra/app/rootfs/ /
USER 10001:10001
WORKDIR /opt
EXPOSE 3000
ENTRYPOINT ["/init"]
