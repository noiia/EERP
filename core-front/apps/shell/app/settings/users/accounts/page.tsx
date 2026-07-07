import Box from '@mui/material/Box'
import Container from '@mui/material/Container'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { EntityViewServer } from '@eerp/core-front/server'
import { CreateBar, T, type EntityActions } from '@eerp/core-front'
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
        {/* Title row carries the Create button (right side); CreateBar hides
            itself without users:users:write. */}
        <Box
          sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2 }}
        >
          <Typography variant="h4" component="h1">
            <T text="User accounts" />
          </Typography>
          <CreateBar descriptor={usersListDescriptor} />
        </Box>
        <EntityViewServer descriptor={usersListDescriptor} actions={actions} />
      </Stack>
    </Container>
  )
}
