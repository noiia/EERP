import Container from '@mui/material/Container'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { EntityViewServer } from '@eerp/core-front/server'
import { T, type EntityActions } from '@eerp/core-front'
import { requireAuth } from '@/lib/session'
import { removeRecord, updateRecord } from '../../../../[...module]/actions'
import { createPageFormatForCompany } from '@/lib/report-settings'
import { getMyLocalePreferences } from '@/lib/preferences'
import { pageFormatFormDescriptor, type ReportPageFormatRecord } from '../descriptors'

// Settings → Global settings → Reports → one page format: the edit form, or
// ("new") the empty create form the Reports accordion's Create button opens.
// Create tags the new row with the caller's active company (multi-company,
// client-enforced scoping only — see appearance/page.tsx's own note).

export default async function ReportPageFormatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await requireAuth(`/settings/appearance/page-formats/${id}`)
  const preferences = await getMyLocalePreferences()
  const activeCompanyId = preferences?.active_company?.id ?? ''

  const actions = {
    create: createPageFormatForCompany.bind(null, activeCompanyId),
    update: updateRecord.bind(null, 'report_page_format'),
    remove: removeRecord.bind(null, 'report_page_format'),
  } as unknown as EntityActions<ReportPageFormatRecord>

  return (
    // maxWidth={false}: the page's width bound is RootLayout's pageInsetX/pageInsetY
    // inset, not MUI's own default "lg" cap — see [...module]/page.tsx's note.
    <Container maxWidth={false} sx={{ py: 4 }}>
      <Stack spacing={3}>
        <Typography variant="h4" component="h1">
          <T text={id === 'new' ? 'New page format' : 'Edit page format'} />
        </Typography>
        <EntityViewServer descriptor={pageFormatFormDescriptor} actions={actions} recordId={id} />
      </Stack>
    </Container>
  )
}
