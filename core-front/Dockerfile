FROM node:26-alpine AS base
RUN apk add --no-cache libc6-compat && npm install -g pnpm@11.8.0

# Build context is the REPO ROOT, mirrored under /app so the in-container layout matches
# the repo: /app/core-front (the pnpm workspace), /app/core/modules (business modules),
# /app/eerp-config.json (shared config). This lets the frontend DISCOVER + transpile
# external module views exactly as it does locally — the pnpm `../core/modules/*`
# workspace link, the build-time discovery codegen, and the manifest's relative imports
# all resolve from this layout.

# --- install deps (cached on manifests) ---
FROM base AS deps
WORKDIR /app/core-front
COPY core-front/pnpm-workspace.yaml core-front/package.json core-front/pnpm-lock.yaml core-front/.npmrc ./
COPY core-front/packages/core-front/package.json ./packages/core-front/
COPY core-front/apps/shell/package.json ./apps/shell/
# External module manifests so the `../core/modules/*` workspace glob links the engine.
COPY core/modules/crm/package.json /app/core/modules/crm/
RUN pnpm install --frozen-lockfile

# --- build engine + shell (discovers external modules) ---
FROM base AS build
ARG API_BASE
ENV API_BASE=$API_BASE
WORKDIR /app/core-front
COPY --from=deps /app /app
COPY core-front/ ./
COPY core/modules/ /app/core/modules/
COPY eerp-config.json /app/eerp-config.json
RUN pnpm -r build

# --- runtime: standalone server only ---
# The standalone trace is rooted at the monorepo, so the entry lives at
# core-front/apps/shell/server.js inside the bundle.
FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
WORKDIR /app
RUN addgroup -S nodejs && adduser -S nextjs -G nodejs
COPY --from=build --chown=nextjs:nodejs /app/core-front/apps/shell/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/core-front/apps/shell/.next/static ./core-front/apps/shell/.next/static
COPY --from=build --chown=nextjs:nodejs /app/core-front/apps/shell/public ./core-front/apps/shell/public
USER nextjs
EXPOSE 3000
CMD ["node", "core-front/apps/shell/server.js"]
