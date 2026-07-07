import Box from '@mui/material/Box'
import Container from '@mui/material/Container'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { EntityViewServer } from '@eerp/core-front/server'
import { CreateBar, T, type EntityActions } from '@eerp/core-front'
import { requireAuth } from '@/lib/session'
import { createRecord, removeRecord, updateRecord } from '../../../[...module]/actions'
import { rolesListDescriptor } from '../descriptors'

// Settings → Users → Roles: the tenant's role list. Rows navigate to the role's
// form (descriptor.formPath).

type AnyRecord = { id: string } & Record<string, unknown>

export default async function RolesPage() {
  await requireAuth('/settings/users/roles')

  const actions = {
    create: createRecord.bind(null, 'roles'),
    update: updateRecord.bind(null, 'roles'),
    remove: removeRecord.bind(null, 'roles'),
  } as unknown as EntityActions<AnyRecord>

  return (
    <Container sx={{ py: 4 }}>
      <Stack spacing={3}>
        {/* Title row carries the Create button (right side); CreateBar hides
            itself without roles:roles:write. */}
        <Box
          sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2 }}
        >
          <Typography variant="h4" component="h1">
            <T text="Roles" />
          </Typography>
          <CreateBar descriptor={rolesListDescriptor} />
        </Box>
        <EntityViewServer descriptor={rolesListDescriptor} actions={actions} />
      </Stack>
    </Container>
  )
}
