FROM node:26-alpine AS base
RUN apk add --no-cache libc6-compat && npm install -g pnpm@11.8.0

# Build context is the REPO ROOT, mirrored under /app so the in-container layout matches
# the repo: /app/core-front (the pnpm workspace), /app/<module_root> (business modules),
# /app/eerp-config.json (shared config). This lets the frontend DISCOVER + transpile
# external module views exactly as it does locally — the pnpm workspace links, the
# build-time discovery codegen, and the manifest's relative imports all resolve from
# this layout.

# --- module roots (driven by eerp-config.json) ---
# Docker COPY can neither read paths out of a JSON file nor glob per-directory
# package.json files without flattening them. This stage takes the whole build context
# (pruned by .dockerignore), reads module_root from eerp-config.json, and exports:
#   /out/manifests/<root>/**/package.json  — structure-preserved, for the install layer
#   /out/modules/<root>/                   — full module sources, for the build layer
# Adding or moving a module root only requires updating eerp-config.json.
FROM base AS modules
WORKDIR /src
COPY . .
RUN node <<'EOF'
const fs = require('fs');
const path = require('path');
fs.mkdirSync('/out/manifests', { recursive: true });
fs.mkdirSync('/out/modules', { recursive: true });
const roots = JSON.parse(fs.readFileSync('eerp-config.json', 'utf8')).module_root;
for (const root of roots) {
  if (!fs.existsSync(root)) continue;
  fs.cpSync(root, path.join('/out/modules', root), { recursive: true });
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name === 'package.json') {
        fs.mkdirSync(path.join('/out/manifests', dir), { recursive: true });
        fs.copyFileSync(p, path.join('/out/manifests', p));
      }
    }
  };
  walk(root);
}
EOF

# --- install deps (cached on manifests) ---
FROM base AS deps
WORKDIR /app/core-front
COPY core-front/pnpm-workspace.yaml core-front/package.json core-front/pnpm-lock.yaml core-front/.npmrc ./
COPY core-front/packages/core-front/package.json ./packages/core-front/
COPY core-front/apps/shell/package.json ./apps/shell/
# External module package.json files (from every module_root) so the workspace globs
# link them; the layer stays cached until a module manifest actually changes.
COPY --from=modules /out/manifests/ /app/
RUN pnpm install --frozen-lockfile

# --- build engine + shell (discovers external modules) ---
FROM base AS build
ARG API_BASE
ENV API_BASE=$API_BASE
ARG API_VERSION
ENV API_VERSION=$API_VERSION
WORKDIR /app/core-front
COPY --from=deps /app /app
COPY core-front/ ./
COPY --from=modules /out/modules/ /app/
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
