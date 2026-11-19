import Container from '@mui/material/Container'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { T } from '@eerp/core-front'
import { requireAuth } from '@/lib/session'
import { getSecurityTxt } from '@/lib/website-settings'
import SecurityTxtForm from './SecurityTxtForm'

export default async function Page() {
  await requireAuth('/settings/website/security-txt')
  const initial = await getSecurityTxt()
  return (
    <Container maxWidth={false} sx={{ py: 4 }}>
      <Stack spacing={3}>
        <Typography variant="h4" component="h1">
          <T text="security.txt" />
        </Typography>
        <SecurityTxtForm initial={initial} />
      </Stack>
    </Container>
  )
}
