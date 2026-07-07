import Container from '@mui/material/Container'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { EntityViewServer } from '@eerp/core-front/server'
import { T, type EntityActions } from '@eerp/core-front'
import { requireAuth } from '@/lib/session'
import { createRecord, removeRecord, updateRecord } from '../../../../[...module]/actions'
import { userFormDescriptor } from '../../descriptors'

// Settings → Users → Accounts → one account: the edit form, or ("new") the empty
// create form the list/dashboard Create button opens. Email is the only field Go
// accepts on save; a created account starts locked (no password) until a
// credential flow sets one.

type AnyRecord = { id: string } & Record<string, unknown>

export default async function UserAccountPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await requireAuth(`/settings/users/accounts/${id}`)

  const actions = {
    create: createRecord.bind(null, 'users'),
    update: updateRecord.bind(null, 'users'),
    remove: removeRecord.bind(null, 'users'),
  } as unknown as EntityActions<AnyRecord>

  return (
    <Container sx={{ py: 4 }}>
      <Stack spacing={3}>
        <Typography variant="h4" component="h1">
          <T text={id === 'new' ? 'New user' : 'Edit user'} />
        </Typography>
        <EntityViewServer descriptor={userFormDescriptor} actions={actions} recordId={id} />
      </Stack>
    </Container>
  )
}
