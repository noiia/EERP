import Container from '@mui/material/Container'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { T } from '@eerp/core-front'
import { requireAuth } from '@/lib/session'
import { listOutbox } from '@/lib/website-settings'
import OutboxTable from './OutboxTable'

// Settings → Website → Outbox: transactional emails (booking confirmations,
// verification links) and their delivery state. Go authorizes mail_outbox:*.
export default async function OutboxPage() {
  await requireAuth('/settings/website/outbox')
  const mails = await listOutbox()
  return (
    <Container maxWidth={false} sx={{ py: 4 }}>
      <Stack spacing={3}>
        <Typography variant="h4" component="h1">
          <T text="Outgoing emails" />
        </Typography>
        <OutboxTable initial={mails} />
      </Stack>
    </Container>
  )
}
