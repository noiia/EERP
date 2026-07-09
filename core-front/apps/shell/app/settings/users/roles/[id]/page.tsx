import Container from '@mui/material/Container'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { EntityViewServer } from '@eerp/core-front/server'
import { T, type EntityActions } from '@eerp/core-front'
import { requireAuth } from '@/lib/session'
import { createRecord, removeRecord, updateRecord } from '../../../../[...module]/actions'
import { roleFormDescriptor } from '../../descriptors'

// Settings → Users → Roles → one role: the edit form. Name and description are
// the only fields Go accepts on save — permission grants keep their own flows.

type AnyRecord = { id: string } & Record<string, unknown>

export default async function RolePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await requireAuth(`/settings/users/roles/${id}`)

  const actions = {
    create: createRecord.bind(null, 'roles'),
    update: updateRecord.bind(null, 'roles'),
    remove: removeRecord.bind(null, 'roles'),
  } as unknown as EntityActions<AnyRecord>

  return (
    // maxWidth={false}: the page's width bound is RootLayout's pageInsetX/pageInsetY
    // inset, not MUI's own default "lg" cap — see [...module]/page.tsx's note. The
    // form itself still self-limits via layout.formMaxWidth regardless.
    <Container maxWidth={false} sx={{ py: 4 }}>
      <Stack spacing={3}>
        <Typography variant="h4" component="h1">
          <T text={id === 'new' ? 'New role' : 'Edit role'} />
        </Typography>
        <EntityViewServer descriptor={roleFormDescriptor} actions={actions} recordId={id} />
      </Stack>
    </Container>
  )
}
