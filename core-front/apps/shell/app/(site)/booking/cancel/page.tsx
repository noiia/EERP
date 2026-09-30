import Container from '@mui/material/Container'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { T } from '@eerp/core-front'
import { cancelByToken } from '@/website/booking-actions'
import { TokenActionForm } from '@/website/TokenActionForm'

// The cancel link of a booking confirmation email (?token=…). Works signed out.
export default async function CancelBookingPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token = '' } = await searchParams
  return (
    <Container maxWidth="sm" sx={{ py: 6 }}>
      <Stack spacing={3}>
        <Typography variant="h4" component="h1"><T text="Cancel this booking?" /></Typography>
        <TokenActionForm action={cancelByToken} token={token} button="Cancel booking" done="Your booking is cancelled." />
      </Stack>
    </Container>
  )
}
