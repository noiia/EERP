import { redirect } from 'next/navigation'
import Container from '@mui/material/Container'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { T } from '@eerp/core-front'
import { getSiteIdentity } from '@/lib/site-session'
import { verifyEmail } from '@/website/booking-actions'
import { TokenActionForm } from '@/website/TokenActionForm'

// The verification link of a signup email (?token=…). Go only accepts it from the
// account's own session, so a signed-out visitor logs in first and comes back.
export default async function VerifyEmailPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token = '' } = await searchParams
  if (!(await getSiteIdentity())) {
    redirect(`/login?next=${encodeURIComponent(`/account/verify?token=${encodeURIComponent(token)}`)}`)
  }
  return (
    <Container maxWidth="sm" sx={{ py: 6 }}>
      <Stack spacing={3}>
        <Typography variant="h4" component="h1"><T text="Confirm your email address" /></Typography>
        <TokenActionForm action={verifyEmail} token={token} button="Confirm my email"
          done="Your email is confirmed. Your earlier bookings now appear in your account." />
      </Stack>
    </Container>
  )
}
