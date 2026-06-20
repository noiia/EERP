FROM node:26-alpine AS base
RUN apk add --no-cache libc6-compat && npm install -g pnpm@11.8.0
WORKDIR /repo

# --- install deps (cached on manifests) ---
FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./
COPY packages/core-front/package.json ./packages/core-front/
COPY apps/shell/package.json ./apps/shell/
RUN pnpm install --frozen-lockfile

# --- build engine + shell ---
FROM base AS build
COPY --from=deps /repo/ ./
COPY . .
RUN pnpm -r build

# --- runtime: standalone server only ---
FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
RUN addgroup -S nodejs && adduser -S nextjs -G nodejs
COPY --from=build --chown=nextjs:nodejs /repo/apps/shell/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /repo/apps/shell/.next/static ./apps/shell/.next/static
COPY --from=build --chown=nextjs:nodejs /repo/apps/shell/public ./apps/shell/public
USER nextjs
EXPOSE 3000
CMD ["node", "apps/shell/server.js"]
