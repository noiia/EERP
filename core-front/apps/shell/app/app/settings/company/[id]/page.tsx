import Container from '@mui/material/Container'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { EntityViewServer } from '@eerp/core-front/server'
import { T, type EntityActions } from '@eerp/core-front'
import { requireAuth } from '@/lib/session'
import { updateRecord, removeRecord } from '../../../[...module]/actions'
import { createCompanyAndActivate } from '@/lib/company'
import { companyFormDescriptor, type CompanyRecord } from '../descriptors'

// Settings → Company → one company: the edit form, or ("new") the empty
// create form the list's Create button opens.

export default async function CompanyFormPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await requireAuth(`/settings/company/${id}`)

  const actions = {
    create: createCompanyAndActivate,
    update: updateRecord.bind(null, 'company'),
    remove: removeRecord.bind(null, 'company'),
  } as unknown as EntityActions<CompanyRecord>

  return (
    // maxWidth={false}: the page's width bound is RootLayout's pageInsetX/pageInsetY
    // inset, not MUI's own default "lg" cap — see [...module]/page.tsx's note.
    <Container maxWidth={false} sx={{ py: 4 }}>
      <Stack spacing={3}>
        <Typography variant="h4" component="h1">
          <T text={id === 'new' ? 'New company' : 'Edit company'} />
        </Typography>
        <EntityViewServer descriptor={companyFormDescriptor} actions={actions} recordId={id} />
      </Stack>
    </Container>
  )
}
