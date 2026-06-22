import type { ReactNode } from 'react'
import { AppRouterCacheProvider } from '@mui/material-nextjs/v16-appRouter'
import { AppThemeProvider } from '../src/components/AppThemeProvider'
import { AppTopBar } from '../src/components/AppTopBar'
import { SessionHydrator } from '../src/components/SessionHydrator'
import { getIdentity } from '../src/lib/session'

export const metadata = {
  title: 'EERP',
  description: 'EERP frontend service',
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Resolve identity on the server and seed the client mirror for UI gating.
  const identity = await getIdentity()
  return (
    <html lang="en">
      <body>
        <AppRouterCacheProvider>
          <AppThemeProvider>
            <SessionHydrator identity={identity} />
            <AppTopBar identity={identity} />
            {children}
          </AppThemeProvider>
        </AppRouterCacheProvider>
      </body>
    </html>
  )
}
