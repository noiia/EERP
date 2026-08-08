import type { ReactNode } from 'react'
import { AppRouterCacheProvider } from '@mui/material-nextjs/v16-appRouter'
import Box from '@mui/material/Box'
import { moduleRegistry } from '@eerp/core-front/server'
// Side-effect import: registers every discovered module so the top-bar nav can resolve
// each module's main pages (same manifest the catch-all route and landing menu import).
import '@/generated/generated-modules'
// Graph mode's drag/resize engine (react-grid-layout, docs/roadmaps/list-view-modes.md
// Phase 4.6) — among the first raw CSS imports in this codebase (everything else
// styles via MUI's sx prop/Emotion). Next's App Router only allows global CSS imports
// from the root layout, so these live here rather than next to graph-renderer.tsx itself.
import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'
// PDF report styling (docs/roadmaps/pdf-reports.md Phase 4) — ReportRenderer renders
// plain DOM (no MUI), so its ReportNode.className hooks need real CSS; eerp-report-
// prefixed class names keep it collision-free with the rest of the app.
import './print/report/report.css'
import { AppThemeProvider } from '../src/components/AppThemeProvider'
import { AppTopBar } from '../src/components/AppTopBar'
import { I18nInit } from '../src/components/I18nInit'
import { LocaleSync } from '../src/components/LocaleSync'
import { ModulesInit } from '../src/components/ModulesInit'
import { SessionHydrator } from '../src/components/SessionHydrator'
import {
  GraphOpsProvider,
  NotebookOpsProvider,
  RelationOpsProvider,
  layout,
} from '@eerp/core-front'
import { activeModuleNames } from '../src/lib/module-state'
import { getIdentity } from '../src/lib/session'
import { getMyLocalePreferences } from '../src/lib/preferences'
import { getEntityGraphLayout, setEntityGraphLayout } from '../src/lib/graph-actions'
import {
  createNotebookPage,
  listNotebookPages,
  removeNotebookPage,
  updateNotebookPage,
} from '../src/lib/notebook-actions'
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
  // Discovery compiles every module regardless of `active` (ADR-009), so a
  // deactivated module's nav entries are filtered out HERE, from the live
  // Go-sourced active state — skipped entirely for an anonymous visitor
  // (no session to authenticate the /api/v1/modules read with, and nothing
  // renders the nav without an identity anyway).
  const activeSet = identity ? await activeModuleNames() : new Set<string>()
  const nav = identity ? moduleRegistry.moduleNav().filter((m) => activeSet.has(m.module)) : []
  return (
    <html lang="en">
      <body>
        <AppRouterCacheProvider>
          <AppThemeProvider>
            <I18nInit />
            <ModulesInit />
            <LocaleSync preferences={preferences} />
            <SessionHydrator identity={identity} />
            {/* Hidden when Chrome prints (tools/pdf-service's Page.printToPDF
                always applies @media print, docs/adr/ADR-010) — a print
                target under /print/report/... renders through this SAME root
                layout (there is only one), so the report's PDF must not
                include the app's own nav chrome. */}
            <Box sx={{ '@media print': { display: 'none' } }}>
              <AppTopBar identity={identity} nav={nav} />
            </Box>
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
              {/* Graph mode's app-wide data path: entity-generic Server Action
                  references over the tenant-scoped settings endpoint — every
                  read/save re-enters Go's permission gate with the caller's
                  session (docs/roadmaps/list-view-modes.md, Phase 4). */}
              <GraphOpsProvider ops={{ get: getEntityGraphLayout, save: setEntityGraphLayout }}>
                {/* A record's own runtime notebook pages (docs/roadmaps/
                    responsive-displays.md, Phase 5) — per-record data, not
                    per-entity settings, so its own context rather than folded
                    into GraphOps. */}
                <NotebookOpsProvider
                  ops={{
                    list: listNotebookPages,
                    create: createNotebookPage,
                    update: updateNotebookPage,
                    remove: removeNotebookPage,
                  }}
                >
                  {/* The ONE page-content inset, applied once here — everything below
                      the top bar (list/form/dashboard/settings, any view) sits inside
                      it, never against or past the screen edge. Graph mode's canvas
                      (react-grid-layout) measures ITS OWN container width to derive its
                      column count, so it naturally sizes itself to whatever this inset
                      provides — overflowX: 'auto' remains a defensive fallback for any
                      other wide inner surface, never a per-view width hack. */}
                  <Box
                    sx={{
                      px: layout.pageInsetX,
                      py: layout.pageInsetY,
                      overflowX: 'auto',
                      '@media print': { p: 0, overflowX: 'visible' },
                    }}
                  >
                    {children}
                  </Box>
                </NotebookOpsProvider>
              </GraphOpsProvider>
            </RelationOpsProvider>
          </AppThemeProvider>
        </AppRouterCacheProvider>
      </body>
    </html>
  )
}
