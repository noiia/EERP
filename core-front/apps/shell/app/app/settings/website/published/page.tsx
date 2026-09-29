import Container from '@mui/material/Container'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { T } from '@eerp/core-front'
import { requireAuth } from '@/lib/session'
import { getPublished } from '@/lib/website-settings'
import PublishedDataForm from './PublishedDataForm'

export default async function PublishedDataPage() {
  await requireAuth('/settings/website/published')
  const tables = await getPublished()
  return (
    <Container maxWidth={false} sx={{ py: 4 }}>
      <Stack spacing={3}>
        <Typography variant="h4" component="h1">
          <T text="Published data" />
        </Typography>
        <PublishedDataForm tables={tables} />
      </Stack>
    </Container>
  )
}
