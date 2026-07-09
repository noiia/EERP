import Container from '@mui/material/Container'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { EntityViewServer } from '@eerp/core-front/server'
import { T, type EntityActions } from '@eerp/core-front'
import { requireAuth } from '@/lib/session'
import { createRecord, removeRecord, updateRecord } from '../../[...module]/actions'
import { usersDashboardDescriptor, usersDashboardListViews } from './descriptors'

// Settings → Users: the entry dashboard — one count card per managed list (user
// accounts, roles), each linking to its tree view. Auth-gated here; Go authorizes
// every data call (users:users:read / roles:roles:read), so a caller without the
// permission sees dashes instead of counts.

type AnyRecord = { id: string } & Record<string, unknown>

export default async function UsersSettingsPage() {
  await requireAuth('/settings/users')

  const actions = {
    create: createRecord.bind(null, 'users'),
    update: updateRecord.bind(null, 'users'),
    remove: removeRecord.bind(null, 'users'),
  } as unknown as EntityActions<AnyRecord>

  return (
    // maxWidth={false}: the page's width bound is RootLayout's pageInsetX/pageInsetY
    // inset, not MUI's own default "lg" cap — see [...module]/page.tsx's note.
    <Container maxWidth={false} sx={{ py: 4 }}>
      <Stack spacing={3}>
        <Typography variant="h4" component="h1">
          <T text="Users" />
        </Typography>
        <EntityViewServer
          descriptor={usersDashboardDescriptor}
          actions={actions}
          listViews={usersDashboardListViews}
        />
      </Stack>
    </Container>
  )
}
