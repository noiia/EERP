import Box from '@mui/material/Box'
import Container from '@mui/material/Container'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { EntityViewServer } from '@eerp/core-front/server'
import { CreateBar, T, type EntityActions } from '@eerp/core-front'
import { requireAuth } from '@/lib/session'
import { updateRecord, removeRecord } from '../../[...module]/actions'
import { createCompanyAndActivate } from '@/lib/company'
import { companyListDescriptor, type CompanyRecord } from './descriptors'

// Settings → Company: the tenant's company list. Rows navigate to the
// company's form (descriptor.formPath). Create is bespoke (not the generic
// createRecord) — a new company clones the creator's active company's
// settings and switches into it (createCompanyAndActivate).

export default async function CompanyListPage() {
  await requireAuth('/settings/company')

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
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2 }}>
          <Typography variant="h4" component="h1">
            <T text="Companies" />
          </Typography>
          <CreateBar descriptor={companyListDescriptor} />
        </Box>
        <EntityViewServer descriptor={companyListDescriptor} actions={actions} />
      </Stack>
    </Container>
  )
}
