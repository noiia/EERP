import { redirect } from 'next/navigation'
import Container from '@mui/material/Container'
import Divider from '@mui/material/Divider'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { T } from '@eerp/core-front'
import { getSiteIdentity } from '@/lib/site-session'
import { getWebsiteMe } from '@/website/account'
import { LogoutButton, ProfileForm } from '@/website/AccountForm'
import { MyBookings } from './MyBookings'

// The website visitor's own account page (ADR-024).
export default async function AccountPage() {
  const me = (await getSiteIdentity()) ? await getWebsiteMe() : null
  if (!me) redirect('/login?next=/account')
  return (
    <Container maxWidth="sm" sx={{ py: 6 }}>
      <Stack spacing={3}>
        <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', gap: 2, flexWrap: 'wrap' }}>
          <Typography variant="h4" component="h1"><T text="My account" /></Typography>
          <LogoutButton />
        </Stack>
        <ProfileForm me={me} />
        <Divider />
        <section>
          <Typography variant="h5" component="h2" gutterBottom><T text="My bookings" /></Typography>
          <MyBookings verified={me.email_verified} />
        </section>
      </Stack>
    </Container>
  )
}
