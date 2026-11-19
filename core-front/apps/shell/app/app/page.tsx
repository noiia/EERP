import { moduleRegistry, solidIcon, type IconDefinition } from '@eerp/core-front/server'
// Side-effect import: registers every discovered module's FrontModule into the shared
// registry before we read the menu (same manifest the catch-all route imports).
import '@/generated/generated-modules'
import { activeModuleNames } from '@/lib/module-state'
import { requireAuth } from '@/lib/session'
import Menu from './Menu'

// Landing route. Anonymous users are redirected to /login (requireAuth). A signed-in
// user who hits the app root gets the application menu: every module registered as an
// application (module.json app_mode: true) whose views the caller actually has
// permission for. This is the fallback any logged-in user lands on after login or when
// opening the service by its URL.
//
// requireAuth's returned identity already carries the JWT `permissions` claim
// (lib/jwt.ts), so it's handed straight to moduleRegistry.menu() — a module with zero
// permitted routes gets no tile (registry.ts's own doc comment has the full contract).
// Go still re-authorizes every actual data call regardless; this only decides what the
// menu offers to click.
//
// Discovery now compiles every module's tile regardless of module.json
// `active` (docs/roadmaps/app-store.md, live lifecycle) — a deactivated
// module's tile is filtered out HERE, from the live Go-sourced active state,
// not baked into the build.
export default async function HomePage() {
  const identity = await requireAuth()
  const active = await activeModuleNames()
  const menu = moduleRegistry.menu(identity.permissions).filter((m) => active.has(m.name))
  // Tile icons are resolved here, on the server: a `menu_icon` may name any Solid
  // icon, and only these few definitions should reach the browser.
  const icons: Record<string, IconDefinition> = {}
  for (const m of menu) {
    const def = solidIcon(m.icon)
    if (def) icons[m.name] = def
  }
  return <Menu menu={menu} icons={icons} />
}
