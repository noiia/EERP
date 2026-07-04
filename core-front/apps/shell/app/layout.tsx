import type { ReactNode } from 'react'
import { AppRouterCacheProvider } from '@mui/material-nextjs/v16-appRouter'
import { moduleRegistry } from '@eerp/core-front/server'
// Side-effect import: registers every discovered module so the top-bar nav can resolve
// each module's main pages (same manifest the catch-all route and landing menu import).
import '@/generated/generated-modules'
import { AppThemeProvider } from '../src/components/AppThemeProvider'
import { AppTopBar } from '../src/components/AppTopBar'
import { I18nInit } from '../src/components/I18nInit'
import { SessionHydrator } from '../src/components/SessionHydrator'
import { getIdentity } from '../src/lib/session'

export const metadata = {
  title: 'EERP',
  description: 'EERP frontend service',
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Resolve identity on the server and seed the client mirror for UI gating.
  const identity = await getIdentity()
  // Per-module main pages for the top-bar nav (plain data → client AppTopBar).
  const nav = moduleRegistry.moduleNav()
  return (
    <html lang="en">
      <body>
        <AppRouterCacheProvider>
          <AppThemeProvider>
            <I18nInit />
            <SessionHydrator identity={identity} />
            <AppTopBar identity={identity} nav={nav} />
            {children}
          </AppThemeProvider>
        </AppRouterCacheProvider>
      </body>
    </html>
  )
}
