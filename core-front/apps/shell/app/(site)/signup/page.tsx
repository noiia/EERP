import { redirect } from 'next/navigation'
import Container from '@mui/material/Container'
import { getSiteIdentity } from '@/lib/site-session'
import { safeNext } from '@/website/urls'
import { SiteAuthForm } from '@/website/SiteAuthForm'

export default async function SiteSignupPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const { next: raw } = await searchParams
  const next = Array.isArray(raw) ? raw[0] : raw
  if (await getSiteIdentity()) redirect(safeNext(next, '/account'))
  return (
    <Container maxWidth="xs" sx={{ py: 6 }}>
      <SiteAuthForm mode="signup" next={next} />
    </Container>
  )
}
