# syntax=docker/dockerfile:1
#
# SeniorSocial — one multi-stage image for `web` and `worker`, local and remote.
# (WP-001; 07-local-stack-and-railway-cutover.md s2, compose-plan.md s5.)
#
# Targets:
#   dev      — the Compose stack's image. Source is bind-mounted; deps live in a
#              named volume. Hot reload.
#   runtime  — the slim deployable, built on Next.js `output: 'standalone'`.
#              Same file Railway builds (WP-042), so the artifact a builder runs,
#              the artifact CI runs, and the artifact that ships are one artifact.
#
# SEC-052: the base image is pinned BY DIGEST, not by tag. A tag is a moving
# pointer; `node:24.18.0-bookworm-slim` can be rebuilt under you. Both stated
# together so a human can read the version and a machine can verify the bytes.
# Resolved 2026-09-10 with `docker buildx imagetools inspect`.
#
# SEC-052: every stage that runs anything runs as a non-root user.

# The digest is written out on every FROM line rather than hidden behind an ARG.
# An ARG default can be overridden at build time (`--build-arg NODE_IMAGE=...`),
# which turns a "pinned" base into whatever the caller wants; a literal digest on
# the FROM line cannot be overridden at all. Updating Node means editing two
# lines here, deliberately, in a diff a reviewer can see.

# ---------------------------------------------------------------------- base
FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NEXT_TELEMETRY_DISABLED=1 \
    DO_NOT_TRACK=1
# corepack ships with Node 24; the version comes from package.json's
# `packageManager` field, so it cannot drift from what the lockfile was built with.
RUN corepack enable
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ---------------------------------------------------------------------- deps
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json ./apps/web/package.json
COPY packages/ai/package.json ./packages/ai/package.json
COPY packages/assistance/package.json ./packages/assistance/package.json
COPY packages/audit/package.json ./packages/audit/package.json
COPY packages/auth/package.json ./packages/auth/package.json
COPY packages/caregiver/package.json ./packages/caregiver/package.json
COPY packages/config/package.json ./packages/config/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/events/package.json ./packages/events/package.json
COPY packages/flags/package.json ./packages/flags/package.json
COPY packages/i18n/package.json ./packages/i18n/package.json
COPY packages/intake/package.json ./packages/intake/package.json
COPY packages/messaging/package.json ./packages/messaging/package.json
COPY packages/notify/package.json ./packages/notify/package.json
COPY packages/policy/package.json ./packages/policy/package.json
COPY packages/rides/package.json ./packages/rides/package.json
COPY packages/services/package.json ./packages/services/package.json
COPY packages/tokens/package.json ./packages/tokens/package.json
COPY packages/ui/package.json ./packages/ui/package.json
COPY packages/worker/package.json ./packages/worker/package.json
# SEC-050: frozen lockfile. SEC-051: `--ignore-scripts` means no dependency's
# postinstall runs here at all; anything that legitimately needs a build step is
# named in pnpm-workspace.yaml's onlyBuiltDependencies and rebuilt explicitly.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts

# ----------------------------------------------------------------------- dev
FROM base AS dev
ENV NODE_ENV=development
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /app/packages/ai/node_modules ./packages/ai/node_modules
COPY --from=deps /app/packages/assistance/node_modules ./packages/assistance/node_modules
COPY --from=deps /app/packages/audit/node_modules ./packages/audit/node_modules
COPY --from=deps /app/packages/auth/node_modules ./packages/auth/node_modules
COPY --from=deps /app/packages/caregiver/node_modules ./packages/caregiver/node_modules
COPY --from=deps /app/packages/config/node_modules ./packages/config/node_modules
COPY --from=deps /app/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=deps /app/packages/events/node_modules ./packages/events/node_modules
COPY --from=deps /app/packages/flags/node_modules ./packages/flags/node_modules
COPY --from=deps /app/packages/i18n/node_modules ./packages/i18n/node_modules
COPY --from=deps /app/packages/intake/node_modules ./packages/intake/node_modules
COPY --from=deps /app/packages/messaging/node_modules ./packages/messaging/node_modules
COPY --from=deps /app/packages/notify/node_modules ./packages/notify/node_modules
COPY --from=deps /app/packages/policy/node_modules ./packages/policy/node_modules
COPY --from=deps /app/packages/rides/node_modules ./packages/rides/node_modules
COPY --from=deps /app/packages/services/node_modules ./packages/services/node_modules
COPY --from=deps /app/packages/ui/node_modules ./packages/ui/node_modules
COPY --from=deps /app/packages/worker/node_modules ./packages/worker/node_modules
# Source arrives by bind mount from Compose; nothing else is copied in, so a
# rebuild is not needed to see an edit.
USER node
EXPOSE 3000
# Start the already-installed Next binary directly. Running pnpm against the
# bind-mounted workspace would attempt dependency reconciliation at container
# startup, bypassing the frozen, ignore-scripts dependency stage above.
CMD ["node", "apps/web/node_modules/next/dist/bin/next", "dev", "apps/web", "--hostname", "0.0.0.0", "--port", "3000"]

# --------------------------------------------------------------------- build
FROM base AS build
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /app/packages/ai/node_modules ./packages/ai/node_modules
COPY --from=deps /app/packages/assistance/node_modules ./packages/assistance/node_modules
COPY --from=deps /app/packages/audit/node_modules ./packages/audit/node_modules
COPY --from=deps /app/packages/auth/node_modules ./packages/auth/node_modules
COPY --from=deps /app/packages/caregiver/node_modules ./packages/caregiver/node_modules
COPY --from=deps /app/packages/config/node_modules ./packages/config/node_modules
COPY --from=deps /app/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=deps /app/packages/events/node_modules ./packages/events/node_modules
COPY --from=deps /app/packages/flags/node_modules ./packages/flags/node_modules
COPY --from=deps /app/packages/i18n/node_modules ./packages/i18n/node_modules
COPY --from=deps /app/packages/intake/node_modules ./packages/intake/node_modules
COPY --from=deps /app/packages/messaging/node_modules ./packages/messaging/node_modules
COPY --from=deps /app/packages/notify/node_modules ./packages/notify/node_modules
COPY --from=deps /app/packages/policy/node_modules ./packages/policy/node_modules
COPY --from=deps /app/packages/rides/node_modules ./packages/rides/node_modules
COPY --from=deps /app/packages/services/node_modules ./packages/services/node_modules
COPY --from=deps /app/packages/ui/node_modules ./packages/ui/node_modules
COPY --from=deps /app/packages/worker/node_modules ./packages/worker/node_modules
COPY . .
RUN pnpm --filter @seniorsocial/web build

# ------------------------------------------------------------------- runtime
FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    DO_NOT_TRACK=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# `output: 'standalone'` traces exactly the files the server needs, so the image
# carries neither the source tree nor a full node_modules.
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/v1/health || exit 1
CMD ["node", "apps/web/server.js"]

# ------------------------------------------------------------------- release
# One immutable artifact supports the web, worker, and pre-deploy migration/seed
# roles. Staging and production select the role with SENIORSOCIAL_PROCESS while
# retaining one OCI manifest digest. This target intentionally carries the
# workspace runtime used by the worker and TypeScript migration entrypoints;
# the smaller `runtime` target remains available for web-only local proof.
FROM base AS release
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    DO_NOT_TRACK=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    SENIORSOCIAL_PROCESS=web
COPY --from=build --chown=node:node /app/package.json /app/pnpm-workspace.yaml /app/tsconfig.base.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/infra/railway ./infra/railway
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static

USER node
EXPOSE 3000 9100
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD if [ "$SENIORSOCIAL_PROCESS" = "worker" ]; then curl -fsS "http://127.0.0.1:${WORKER_HEALTH_PORT:-9100}/healthz"; else curl -fsS "http://127.0.0.1:${PORT:-3000}/api/v1/health"; fi
CMD ["node", "infra/railway/process-entrypoint.mjs"]
