import type { FrontModule } from '@eerp/core-front'

// teams frontend: a single tile route. The pages (chat, files) are shell-owned
// and registered by the shell, not descriptor-driven.
const teamsModule: FrontModule = {
  name: 'teams',
  routes: [{ path: '/teams', descriptor: { entity: 'team', viewType: 'dashboard', fields: [], permissions: [] } }],
}

export default teamsModule
