import Box from '@mui/material/Box'
import Container from '@mui/material/Container'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { EntityView, type EntityActions, type ViewDescriptor } from '@eerp/core-front'
import { createServerApiClient, moduleRegistry, serializeError, toApiError } from '@eerp/core-front/server'
// Side-effect import: registers every discovered module's FrontModule into
// the shared registry — this page reads moduleRegistry directly (both for
// the resolved form descriptor AND the Views rows below), bypassing the
// generic catch-all entirely, so it needs the same manifest import that
// route otherwise provides.
import '@/generated/generated-modules'
import { requireAuth } from '@/lib/session'
import { createRecord, removeRecord, updateRecord } from '../../[...module]/actions'
import { ActivateButton } from './ActivateButton'
import { LogsButton } from './LogsButton'
import { moduleViewRows } from './module-views'
import { ReloadButton } from './ReloadButton'

// The App Store's ONE hand-built page (docs/roadmaps/app-store.md, Phase 3) —
// mirrors Settings → Views' "hand-built host page reusing the generic
// engine" shape (core-front/CLAUDE.md): it fetches the module.json record
// from Go AND reads the compiled moduleRegistry server-side to build the
// Views rows, merges the two into one seed, and renders the ordinary
// EntityView/LayoutForm on it — no bespoke rendering, just a bespoke seed.
// A real, static Next.js route (not the `[...module]` catch-all) is required
// here specifically because that catch-all only ever fetches from Go.

type ModuleRecord = {
  id: string
  display_name: string
  active: boolean
  type?: string
  module_dir?: string
} & Record<string, unknown>

export default async function AppStoreFormPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await requireAuth(`/appstore/${id}`)

  // The resolved descriptor — including the Views/Reports notebook pages
  // appstore's own self-extension adds (AppStoreViews.ts) — comes from the
  // SAME registry the catch-all reads; this page just doesn't go through it.
  const route = moduleRegistry.buildRegistry().get('/appstore/:id')
  const descriptor = route?.descriptor as ViewDescriptor<ModuleRecord> | undefined

  const client = createServerApiClient()
  let record: ModuleRecord | null = null
  let error: ReturnType<typeof serializeError> | null = null
  try {
    record = await client.get<ModuleRecord>('modules', id)
  } catch (e) {
    error = serializeError(toApiError(e))
  }

  const staticFiles = record?.static_files as { views?: string[] } | undefined
  const file = staticFiles?.views?.[0] ?? ''
  const initialData = record
    ? [{ ...record, views: file ? moduleViewRows(id, file, record.module_dir) : [], reports: [] }]
    : []

  const actions = {
    create: createRecord.bind(null, 'modules'),
    update: updateRecord.bind(null, 'modules'),
    remove: removeRecord.bind(null, 'modules'),
  } as unknown as EntityActions<ModuleRecord>

  return (
    <Container maxWidth={false} sx={{ py: 4 }}>
      <Stack spacing={3}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2 }}>
          {/* The module's own display_name is DATA, never translated — same
              split as a catalog row's own title. */}
          <Typography variant="h4" component="h1">
            {record?.display_name ?? id}
          </Typography>
          {record ? (
            <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
              <LogsButton name={id} />
              <ReloadButton name={id} type={record.type} />
              <ActivateButton name={id} active={record.active} />
            </Stack>
          ) : null}
        </Box>
        {descriptor ? (
          <EntityView
            // createFormStore seeds ONCE (a lazy useState initializer) and
            // never re-reads initialData on a later prop change — fine for
            // the generic catch-all, where every write goes THROUGH that
            // same store's own commit(), which reconciles itself. The
            // Activate/Deactivate button deliberately mutates OUTSIDE the
            // form store (decision #6), then calls router.refresh() — a new
            // server fetch, but the SAME component instance unless keyed.
            // Since every field here is readOnly anyway (no local edit state
            // to lose), keying on the record's own content forces a full
            // remount exactly when it actually changed, so the read-only
            // Active/App mode toggles never go stale after a toggle.
            key={JSON.stringify(record)}
            descriptor={descriptor}
            initialData={initialData}
            actions={actions}
            error={error}
          />
        ) : null}
      </Stack>
    </Container>
  )
}
