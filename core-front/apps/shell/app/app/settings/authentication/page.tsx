import Alert from '@mui/material/Alert'
import Container from '@mui/material/Container'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { T } from '@eerp/core-front'
import { requireAuth } from '@/lib/session'
import { getAuthSettings, listRoles } from '@/lib/auth-settings'
import AuthSettingsForm from './AuthSettingsForm'

export default async function AuthenticationPage() {
  await requireAuth('/settings/authentication')
  const [loaded, roles] = await Promise.all([getAuthSettings(), listRoles()])
  return (
    <Container maxWidth={false} sx={{ py: 4 }}>
      <Stack spacing={3}>
        <Typography variant="h4" component="h1">
          <T text="Authentication" />
        </Typography>
        {loaded.ok ? (
          <AuthSettingsForm initial={loaded.settings} roles={roles} />
        ) : (
          <Alert severity="error">
            {loaded.message || <T text="Could not load the authentication settings." />}
          </Alert>
        )}
      </Stack>
    </Container>
  )
}
