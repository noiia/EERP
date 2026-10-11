import Container from '@mui/material/Container'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { T } from '@eerp/core-front'
import { requireAuth } from '@/lib/session'
import { getAuthSettings, listRoles } from '@/lib/auth-settings'
import AuthSettingsForm from './AuthSettingsForm'

export default async function AuthenticationPage() {
  await requireAuth('/settings/authentication')
  const [initial, roles] = await Promise.all([getAuthSettings(), listRoles()])
  return (
    <Container maxWidth={false} sx={{ py: 4 }}>
      <Stack spacing={3}>
        <Typography variant="h4" component="h1">
          <T text="Authentication" />
        </Typography>
        <AuthSettingsForm initial={initial} roles={roles} />
      </Stack>
    </Container>
  )
}
