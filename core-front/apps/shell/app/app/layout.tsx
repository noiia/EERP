import type { ReactNode } from 'react'
import Box from '@mui/material/Box'
import { moduleRegistry } from '@eerp/core-front/server'
// Side-effect import: registers every discovered module so the top-bar nav can resolve
// each module's main pages (same manifest the catch-all route and landing menu import).
import '@/generated/generated-modules'
import { AppTopBar } from '../../src/components/AppTopBar'
import { ModulesInit } from '../../src/components/ModulesInit'
import { PresenceInit } from '../../src/components/PresenceInit'
import { SettingsUsersRegistryInit } from '../../src/components/SettingsUsersRegistryInit'
import { SessionHydrator } from '../../src/components/SessionHydrator'
import {
  ChatterOpsProvider,
  GraphOpsProvider,
  NotebookOpsProvider,
  RelationOpsProvider,
  SavedFilterOpsProvider,
  UndoToastHost,
  layout,
} from '@eerp/core-front'
import { activeModuleNames } from '../../src/lib/module-state'
import { getIdentity } from '../../src/lib/session'
import { getMyLocalePreferences } from '../../src/lib/preferences'
import { listCompanies } from '../../src/lib/company'
import { createChatterMessage, listChatterMessages } from '../../src/lib/chatter-actions'
import {
  aggregateEntity,
  createEntityGraphField,
  deleteEntityGraphField,
  getEntityGraphLayout,
  listEntityGraphFields,
  setEntityGraphLayout,
  updateEntityGraphField,
} from '../../src/lib/graph-actions'
import {
  createNotebookPage,
  listNotebookPages,
  removeNotebookPage,
  updateNotebookPage,
} from '../../src/lib/notebook-actions'
import {
  createRelationRecord,
  distinctValues,
  getRecord,
  listRecords,
  listRecordsPage,
  removeRelationRecord,
} from '../../src/lib/relation-actions'
import {
  createSavedFilter,
  listSavedFilters,
  removeSavedFilter,
  updateSavedFilter,
} from '../../src/lib/saved-filter-actions'

// The ERP chrome (website spec 2): every ERP page lives under /app, so the
// session-bound shell — top bar, module registration, session mirror, presence,
// and the app-wide data-path providers — renders only here. The root layout keeps
// just what the public site shares (theme, i18n); /print report targets sit
// outside /app and so render without any of this.
export default async function ErpLayout({ children }: { children: ReactNode }) {
  // Resolve identity on the server and seed the client mirror for UI gating.
  const identity = await getIdentity()
  // The caller's preferences (email + active company for the top bar). The root
  // layout reads the same GET for LocaleSync; Next's request memoization dedupes it.
  const preferences = identity ? await getMyLocalePreferences() : null
  // Per-module top-bar header menus (plain data → client AppTopBar) — see
  // ModuleRegistry.headerMenus(). Discovery compiles every module regardless
  // of `active` (ADR-009), so a deactivated module's menus are filtered out
  // HERE, from the live Go-sourced active state — skipped entirely for an
  // anonymous visitor (no session to authenticate the /api/v1/modules read
  // with, and nothing renders the bar without an identity anyway).
  const activeSet = identity ? await activeModuleNames() : new Set<string>()
  const headerMenus = identity
    ? moduleRegistry.headerMenus().filter((m) => activeSet.has(m.module))
    : []
  // Every company in the tenant, for the top-bar switcher's menu (multi-
  // company) — only worth fetching once we know there's an active company
  // to switch AWAY from.
  const companies = preferences?.active_company ? await listCompanies() : []
  return (
    <>
      <ModulesInit />
      <SettingsUsersRegistryInit />
      <SessionHydrator identity={identity} />
      <PresenceInit />
      {/* The generic "undo a hard delete" toast (search-bar.tsx's saved-
          filter delete, calendar-renderer.tsx's drag-to-unschedule) —
          one instance app-wide, a plain Zustand store underneath so any
          component can trigger it without a context/provider. */}
      <UndoToastHost />
      {/* Hidden when Chrome prints (tools/pdf-service's Page.printToPDF
          always applies @media print, docs/adr/ADR-010) — kept even though
          /print/report/... now sits outside this layout, so printing any
          ERP page still leaves the nav chrome off the paper. */}
      <Box sx={{ '@media print': { display: 'none' } }}>
        <AppTopBar
          identity={identity}
          headerMenus={headerMenus}
          email={preferences?.email}
          activeCompany={preferences?.active_company ?? null}
          companies={companies}
        />
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
          distinctValues,
          listPage: listRecordsPage,
        }}
      >
        {/* Graph mode's app-wide data path: entity-generic Server Action
            references over the tenant-scoped settings endpoint — every
            read/save re-enters Go's permission gate with the caller's
            session (docs/roadmaps/list-view-modes.md, Phase 4). */}
        <GraphOpsProvider ops={{
          get: getEntityGraphLayout,
          save: setEntityGraphLayout,
          listFields: listEntityGraphFields,
          createField: createEntityGraphField,
          updateField: updateEntityGraphField,
          deleteField: deleteEntityGraphField,
          aggregate: aggregateEntity,
        }}>
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
            {/* A record's own activity feed (the form chatter panel) —
                per-record data like NotebookOps, its own context for the
                same reason. */}
            <ChatterOpsProvider
              ops={{ list: listChatterMessages, create: createChatterMessage }}
            >
              {/* The search bar's named, reusable filter combinations
                  (docs/adr/ADR-014-search-filter-bar.md) — independent
                  named rows a user creates/renames/deletes, the same
                  shape NotebookOps already takes. */}
              <SavedFilterOpsProvider
                ops={{
                  list: listSavedFilters,
                  create: createSavedFilter,
                  update: updateSavedFilter,
                  remove: removeSavedFilter,
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
              </SavedFilterOpsProvider>
            </ChatterOpsProvider>
          </NotebookOpsProvider>
        </GraphOpsProvider>
      </RelationOpsProvider>
    </>
  )
}
