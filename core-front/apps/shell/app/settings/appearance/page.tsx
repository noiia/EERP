import { CreateBar, hasPermission, type EntityActions } from '@eerp/core-front'
import { EntityViewServer } from '@eerp/core-front/server'
import { getEffectivePermissions, requireAuth } from '@/lib/session'
import { getReportsLayout } from '@/lib/report-settings'
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
export default async function AppearancePage() {
  await requireAuth('/settings/appearance')
  const [permissions, reportsLayout] = await Promise.all([getEffectivePermissions(), getReportsLayout()])

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
          <EntityViewServer descriptor={pageFormatListDescriptor} actions={pageFormatActions} />
        </>
      }
    />
  )
}
