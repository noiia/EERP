import Container from '@mui/material/Container'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { EntityViewServer } from '@eerp/core-front/server'
import { T, type EntityActions } from '@eerp/core-front'
import { requireAuth } from '@/lib/session'
import { createRecord, removeRecord, updateRecord } from '../../../[...module]/actions'
import { rightsListDescriptor } from '../descriptors'

// Settings → Users → Rights: the tenant's fixed deny/read/write/delete catalog,
// read-only here (rightsListDescriptor has no formPath/createPermission).

type AnyRecord = { id: string } & Record<string, unknown>

export default async function RightsPage() {
  await requireAuth('/settings/users/rights')

  const actions = {
    create: createRecord.bind(null, 'account_role_types'),
    update: updateRecord.bind(null, 'account_role_types'),
    remove: removeRecord.bind(null, 'account_role_types'),
  } as unknown as EntityActions<AnyRecord>

  return (
    // maxWidth={false}: the page's width bound is RootLayout's pageInsetX/pageInsetY
    // inset, not MUI's own default "lg" cap — see [...module]/page.tsx's note.
    <Container maxWidth={false} sx={{ py: 4 }}>
      <Stack spacing={3}>
        <Typography variant="h4" component="h1">
          <T text="Rights" />
        </Typography>
        <EntityViewServer descriptor={rightsListDescriptor} actions={actions} />
      </Stack>
    </Container>
  )
}
