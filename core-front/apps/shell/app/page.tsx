import { moduleRegistry } from '@eerp/core-front/server'
// Side-effect import: registers every discovered module's FrontModule into the shared
// registry before we read the menu (same manifest the catch-all route imports).
import '@/generated/generated-modules'
import Menu from './Menu'

// Landing route. Anonymous users are redirected to /login (requireAuth). A signed-in
// user who hits the app root gets the application menu: every installed module and its
// navigable views. This is the fallback any logged-in user lands on after login or when
// opening the service by its URL.
//
// We gate on AUTHENTICATION only here — the same stance the catch-all module route takes
// — and let Go authorize each data call. The frontend can't yet permission-filter the
// menu: the access token carries no `permissions` claim (see lib/jwt.ts), so the session
// mirror's permission set is empty and filtering would hide everything. Once Go exposes
// permissions in the token, re-introduce a per-route gate via `hasPermission`.
export default async function HomePage() {
  return <Menu menu={moduleRegistry.menu()} />
}
