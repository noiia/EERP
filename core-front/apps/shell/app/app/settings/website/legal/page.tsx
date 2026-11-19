import Container from '@mui/material/Container'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { T } from '@eerp/core-front'
import { requireAuth } from '@/lib/session'
import { getLegal } from '@/lib/website-settings'
import LegalForm from './LegalForm'

export default async function Page() {
  await requireAuth('/settings/website/legal')
  const initial = await getLegal()
  return (
    <Container maxWidth={false} sx={{ py: 4 }}>
      <Stack spacing={3}>
        <Typography variant="h4" component="h1">
          <T text="Legal notice" />
        </Typography>
        <LegalForm initial={initial} />
      </Stack>
    </Container>
  )
}
