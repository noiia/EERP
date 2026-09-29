import Container from '@mui/material/Container'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { EntityViewServer } from '@eerp/core-front/server'
import { T, type EntityActions } from '@eerp/core-front'
import { requireAuth } from '@/lib/session'
import { createRecord, removeRecord, updateRecord } from '../../../../../[...module]/actions'
import { roleViewPermissionFormDescriptor } from '../../../descriptors'

// Settings → Users → Roles → one role → one view's rights: reached by
// clicking a row in (or the "+ Add" line under) the role form's "Views"
// table. role_id is preset by the wizard on creation; editable here too,
// same posture as sale_line's own dedicated form re: its invoice_id.

type AnyRecord = { id: string } & Record<string, unknown>

export default async function RoleViewPermissionPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  await requireAuth(`/settings/users/roles/rights/${id}`)

  const actions = {
    create: createRecord.bind(null, 'role_view_permission'),
    update: updateRecord.bind(null, 'role_view_permission'),
    remove: removeRecord.bind(null, 'role_view_permission'),
  } as unknown as EntityActions<AnyRecord>

  return (
    // maxWidth={false}: the page's width bound is RootLayout's pageInsetX/pageInsetY
    // inset, not MUI's own default "lg" cap — see [...module]/page.tsx's note. The
    // form itself still self-limits via layout.formMaxWidth regardless.
    <Container maxWidth={false} sx={{ py: 4 }}>
      <Stack spacing={3}>
        <Typography variant="h4" component="h1">
          <T text={id === 'new' ? 'New view right' : 'Edit view right'} />
        </Typography>
        <EntityViewServer descriptor={roleViewPermissionFormDescriptor} actions={actions} recordId={id} />
      </Stack>
    </Container>
  )
}
