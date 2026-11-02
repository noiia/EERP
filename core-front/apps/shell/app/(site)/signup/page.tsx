import { redirect } from 'next/navigation'
import Container from '@mui/material/Container'
import { getSiteIdentity } from '@/lib/site-session'
import { SiteAuthForm } from '@/website/SiteAuthForm'

export default async function SiteSignupPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  if (await getSiteIdentity()) redirect('/account')
  const { next: raw } = await searchParams
  const next = Array.isArray(raw) ? raw[0] : raw
  return (
    <Container maxWidth="xs" sx={{ py: 6 }}>
      <SiteAuthForm mode="signup" next={next} />
    </Container>
  )
}
