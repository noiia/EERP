import Container from '@mui/material/Container'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { T } from '@eerp/core-front'
import { claimByToken } from '@/website/booking-actions'
import { TokenActionForm } from '@/website/TokenActionForm'

// The link of a waiting-list offer email (?token=…): a seat freed up and this
// visitor may book it until the offer expires. Works signed out.
export default async function ClaimSeatPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token = '' } = await searchParams
  return (
    <Container maxWidth="sm" sx={{ py: 6 }}>
      <Stack spacing={3}>
        <Typography variant="h4" component="h1"><T text="A seat is free" /></Typography>
        <TokenActionForm action={claimByToken} token={token} button="Book my seat" done="Your seat is booked — a confirmation email is on its way." />
      </Stack>
    </Container>
  )
}
