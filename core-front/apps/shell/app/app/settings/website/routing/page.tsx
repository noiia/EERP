import Container from '@mui/material/Container'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { T } from '@eerp/core-front'
import { requireAuth } from '@/lib/session'
import { getRouting } from '@/lib/website-settings'
import RoutingForm from './RoutingForm'

export default async function RoutingPage() {
  await requireAuth('/settings/website/routing')
  const routing = await getRouting()
  return (
    <Container maxWidth={false} sx={{ py: 4 }}>
      <Stack spacing={3}>
        <Typography variant="h4" component="h1">
          <T text="Routing" />
        </Typography>
        <RoutingForm initial={routing} />
      </Stack>
    </Container>
  )
}
