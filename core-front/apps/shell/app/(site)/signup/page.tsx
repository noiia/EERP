import { redirect } from 'next/navigation'
import Container from '@mui/material/Container'
import { getSiteIdentity } from '@/lib/site-session'
import { SiteAuthForm } from '@/website/SiteAuthForm'

export default async function SiteSignupPage() {
  if (await getSiteIdentity()) redirect('/account')
  return (
    <Container maxWidth="xs" sx={{ py: 6 }}>
      <SiteAuthForm mode="signup" />
    </Container>
  )
}
