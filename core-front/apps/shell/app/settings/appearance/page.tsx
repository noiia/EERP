import { CreateBar, hasPermission, type EntityActions } from '@eerp/core-front'
import { EntityViewServer } from '@eerp/core-front/server'
import { getEffectivePermissions, requireAuth } from '@/lib/session'
import { getReportsLayout } from '@/lib/report-settings'
import { getMyLocalePreferences } from '@/lib/preferences'
import { createRecord, removeRecord, updateRecord } from '../../[...module]/actions'
import { pageFormatListDescriptor, type ReportPageFormatRecord } from './page-formats/descriptors'
import AppearanceSettings from '@/components/AppearanceSettings'

// Settings → Global settings (formerly "Appearance"): the brand-color manager
// plus the PDF report letterhead/page-format settings, both auth-gated. The
// editor itself is a Client Component (it edits the persisted palette in
// useUiStore and the shell themes off that store, so edits re-theme the app
// live) — this Server Component resolves what it can't: the caller's
// settings:reports:write permission, the current global footer/address, and
// the page-format table+Create button (EntityViewServer/CreateBar are Server
// Components, so they're built HERE and passed down as a slot — a Client
// Component can render, but never import, a Server Component).
//
// Page formats are scoped to the active company CLIENT-side only (a
// filter[company_id]= on the list, company_id set on create) — the same
// "no ORM-level second scoping column" boundary multi-company deliberately
// leaves unenforced for this table, since it's reached through the fully
// generic CRUD surface rather than a dedicated handler like app_settings.
export default async function AppearancePage() {
  await requireAuth('/settings/appearance')
  const [permissions, reportsLayout, preferences] = await Promise.all([
    getEffectivePermissions(),
    getReportsLayout(),
    getMyLocalePreferences(),
  ])
  const activeCompanyId = preferences?.active_company?.id

  // create is unused in practice: CreateBar navigates to the form route
  // rather than calling this tree view's own actions.create — the real
  // company-tagged create lives in page-formats/[id]/page.tsx, where
  // creation actually happens. Kept generic here only to satisfy
  // EntityActions<T>'s shape.
  const pageFormatActions = {
    create: createRecord.bind(null, 'report_page_format'),
    update: updateRecord.bind(null, 'report_page_format'),
    remove: removeRecord.bind(null, 'report_page_format'),
  } as unknown as EntityActions<ReportPageFormatRecord>

  return (
    <AppearanceSettings
      canEditReports={hasPermission(permissions, 'settings:reports:write')}
      initialFooter={reportsLayout.footer}
      initialAddress={reportsLayout.address}
      reportPageFormats={
        <>
          <CreateBar descriptor={pageFormatListDescriptor} />
          <EntityViewServer
            descriptor={pageFormatListDescriptor}
            actions={pageFormatActions}
            listOptions={activeCompanyId ? { filter: { company_id: activeCompanyId } } : undefined}
          />
        </>
      }
    />
  )
}
