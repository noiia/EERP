import Container from '@mui/material/Container'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { T } from '@eerp/core-front'
import { requireAuth } from '@/lib/session'
import { getWebsiteLocalization } from '@/lib/website-settings'
import LocalizationForm from './LocalizationForm'

export default async function LocalizationPage() {
  await requireAuth('/settings/website/localization')
  const initial = await getWebsiteLocalization()
  return (
    <Container maxWidth={false} sx={{ py: 4 }}>
      <Stack spacing={3}>
        <Typography variant="h4" component="h1">
          <T text="Language & currency" />
        </Typography>
        <LocalizationForm initial={initial} />
      </Stack>
    </Container>
  )
}
