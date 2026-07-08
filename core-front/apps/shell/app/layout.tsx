import type { ReactNode } from 'react'
import { AppRouterCacheProvider } from '@mui/material-nextjs/v16-appRouter'
import { moduleRegistry } from '@eerp/core-front/server'
// Side-effect import: registers every discovered module so the top-bar nav can resolve
// each module's main pages (same manifest the catch-all route and landing menu import).
import '@/generated/generated-modules'
import { AppThemeProvider } from '../src/components/AppThemeProvider'
import { AppTopBar } from '../src/components/AppTopBar'
import { I18nInit } from '../src/components/I18nInit'
import { LocaleSync } from '../src/components/LocaleSync'
import { ModulesInit } from '../src/components/ModulesInit'
import { SessionHydrator } from '../src/components/SessionHydrator'
import { RelationOpsProvider } from '@eerp/core-front'
import { getIdentity } from '../src/lib/session'
import { getMyLocalePreferences } from '../src/lib/preferences'
import {
  createRelationRecord,
  getRecord,
  listRecords,
  removeRelationRecord,
} from '../src/lib/relation-actions'

export const metadata = {
  title: 'EERP',
  description: 'EERP frontend service',
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Resolve identity on the server and seed the client mirror for UI gating.
  const identity = await getIdentity()
  // Server-owned language preferences (user choice + workspace default) → LocaleSync
  // applies them to the client i18n store. Anonymous visitors keep the local state.
  const preferences = identity ? await getMyLocalePreferences() : null
  // Per-module main pages for the top-bar nav (plain data → client AppTopBar).
  const nav = moduleRegistry.moduleNav()
  return (
    <html lang="en">
      <body>
        <AppRouterCacheProvider>
          <AppThemeProvider>
            <I18nInit />
            <ModulesInit />
            <LocaleSync preferences={preferences} />
            <SessionHydrator identity={identity} />
            <AppTopBar identity={identity} nav={nav} />
            {/* Relation widgets' app-wide data path: entity-generic Server Action
                references — every relation query re-enters Go's permission gate
                with the caller's session. */}
            <RelationOpsProvider
              ops={{
                list: listRecords,
                get: getRecord,
                create: createRelationRecord,
                remove: removeRelationRecord,
              }}
            >
              {children}
            </RelationOpsProvider>
          </AppThemeProvider>
        </AppRouterCacheProvider>
      </body>
    </html>
  )
}
