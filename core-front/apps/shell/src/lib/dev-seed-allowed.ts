import 'server-only'
import { getMyLocalePreferences } from './preferences'

/**
 * Whether the demo-seed tool may run. Sourced from the SAME backend config the
 * Go server itself boots from (types.Config.Environment, "development"/"production"
 * — echoed back on GET /me/preferences, since core-front never reads the backend
 * config file at runtime, only at build time for module discovery — see
 * core-front/CLAUDE.md's BFF boundary). Replaces the old NODE_ENV/ALLOW_DEMO_SEED
 * pair: the standalone Docker image always sets NODE_ENV=production regardless of
 * whether the deployment is a real tenant, so that env var could never tell the two
 * apart on its own — a single, explicit backend switch does.
 */
export async function seedingAllowed(): Promise<boolean> {
  const preferences = await getMyLocalePreferences()
  return preferences?.environment === 'development'
}
