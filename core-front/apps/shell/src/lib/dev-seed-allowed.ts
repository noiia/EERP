// Split out of dev-seed.ts: that file is 'use server', and Next.js requires every
// top-level export of a 'use server' module to be an async Server Action — a plain
// sync env check doesn't qualify, so it lives here instead and dev-seed.ts imports it.

/**
 * NODE_ENV alone can't tell "a real production deployment" apart from "a dev/local
 * deployment running the production Next build" — the standalone Docker image (see
 * core-front/Dockerfile) always sets NODE_ENV=production, since that's required for
 * `next start` to run correctly, even when compose.yml is standing it up for local
 * dev. ALLOW_DEMO_SEED lets such a deployment opt back in explicitly, the same way
 * COOKIE_SECURE overrides the NODE_ENV-derived default in session-cookies.ts.
 */
export function seedingAllowed(): boolean {
  if (process.env.ALLOW_DEMO_SEED !== undefined) {
    return process.env.ALLOW_DEMO_SEED === 'true'
  }
  return process.env.NODE_ENV !== 'production'
}
