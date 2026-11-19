import Container from '@mui/material/Container'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { T } from '@eerp/core-front'
import { requireAuth } from '@/lib/session'
import { getRobotsExtra } from '@/lib/website-settings'
import RobotsTxtForm from './RobotsTxtForm'

export default async function Page() {
  await requireAuth('/settings/website/robots-txt')
  const initial = await getRobotsExtra()
  return (
    <Container maxWidth={false} sx={{ py: 4 }}>
      <Stack spacing={3}>
        <Typography variant="h4" component="h1">
          <T text="robots.txt" />
        </Typography>
        <RobotsTxtForm initial={initial} />
      </Stack>
    </Container>
  )
}
