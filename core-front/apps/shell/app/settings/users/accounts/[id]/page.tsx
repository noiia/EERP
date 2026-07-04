import Container from '@mui/material/Container'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { EntityViewServer } from '@eerp/core-front/server'
import { T, type EntityActions } from '@eerp/core-front'
import { requireAuth } from '@/lib/session'
import { createRecord, removeRecord, updateRecord } from '../../../../[...module]/actions'
import { userFormDescriptor } from '../../descriptors'

// Settings → Users → Accounts → one account: the edit form. Email is the only
// field Go accepts on save; everything else in the record is read-only context.

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
          <T text="Edit user" />
        </Typography>
        <EntityViewServer descriptor={userFormDescriptor} actions={actions} recordId={id} />
      </Stack>
    </Container>
  )
}
