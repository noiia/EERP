import Container from '@mui/material/Container'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { T } from '@eerp/core-front'
import { requireAuth } from '@/lib/session'
import { listWebsiteUsers } from '@/lib/website-settings'
import WebsiteUsersTable from './WebsiteUsersTable'

export default async function WebsiteUsersPage() {
  await requireAuth('/settings/website/users')
  const users = await listWebsiteUsers()
  return (
    <Container maxWidth={false} sx={{ py: 4 }}>
      <Stack spacing={3}>
        <Typography variant="h4" component="h1">
          <T text="Website users" />
        </Typography>
        <WebsiteUsersTable initial={users} />
      </Stack>
    </Container>
  )
}
