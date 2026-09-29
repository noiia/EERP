import type { ReactNode } from 'react'
import { AppRouterCacheProvider } from '@mui/material-nextjs/v16-appRouter'
// Graph mode's drag/resize engine (react-grid-layout, docs/roadmaps/list-view-modes.md
// Phase 4.6) — among the first raw CSS imports in this codebase (everything else
// styles via MUI's sx prop/Emotion). Global CSS is kept in the root layout so every
// route segment (the ERP under /app, the report print targets) gets it.
import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'
// PDF report styling (docs/roadmaps/pdf-reports.md Phase 4) — ReportRenderer renders
// plain DOM (no MUI), so its ReportNode.className hooks need real CSS; eerp-report-
// prefixed class names keep it collision-free with the rest of the app.
import './print/report/report.css'
import { AppThemeProvider } from '../src/components/AppThemeProvider'
import { I18nInit } from '../src/components/I18nInit'
import { LocaleSync } from '../src/components/LocaleSync'
import { getIdentity } from '../src/lib/session'
import { getMyLocalePreferences } from '../src/lib/preferences'

export const metadata = {
  title: 'EERP',
  description: 'EERP frontend service',
}

// The root layout is shared by the public website (/), the ERP (/app — its chrome
// lives in app/app/layout.tsx) and the report print targets (/print). It holds only
// what all of them need: theme, translations, and the server-owned locale.
export default async function RootLayout({ children }: { children: ReactNode }) {
  // Server-owned language preferences (user choice + workspace default) → LocaleSync
  // applies them to the client i18n store. Anonymous visitors keep the local state.
  const preferences = (await getIdentity()) ? await getMyLocalePreferences() : null
  return (
    <html lang="en">
      <body>
        <AppRouterCacheProvider>
          <AppThemeProvider>
            <I18nInit />
            <LocaleSync preferences={preferences} />
            {children}
          </AppThemeProvider>
        </AppRouterCacheProvider>
      </body>
    </html>
  )
}
