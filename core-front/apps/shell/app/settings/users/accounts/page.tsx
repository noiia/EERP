import Container from '@mui/material/Container'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { EntityViewServer } from '@eerp/core-front/server'
import { T, type EntityActions } from '@eerp/core-front'
import { requireAuth } from '@/lib/session'
import { createRecord, removeRecord, updateRecord } from '../../../[...module]/actions'
import { usersListDescriptor } from '../descriptors'

// Settings → Users → Accounts: the tenant's user list. Rows navigate to the
// account's form (descriptor.formPath).

type AnyRecord = { id: string } & Record<string, unknown>

export default async function UserAccountsPage() {
  await requireAuth('/settings/users/accounts')

  const actions = {
    create: createRecord.bind(null, 'users'),
    update: updateRecord.bind(null, 'users'),
    remove: removeRecord.bind(null, 'users'),
  } as unknown as EntityActions<AnyRecord>

  return (
    <Container sx={{ py: 4 }}>
      <Stack spacing={3}>
        <Typography variant="h4" component="h1">
          <T text="User accounts" />
        </Typography>
        <EntityViewServer descriptor={usersListDescriptor} actions={actions} />
      </Stack>
    </Container>
  )
}
