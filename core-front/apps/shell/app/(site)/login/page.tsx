import { redirect } from 'next/navigation'
import Container from '@mui/material/Container'
import { getSiteIdentity } from '@/lib/site-session'
import { SiteAuthForm } from '@/website/SiteAuthForm'

export default async function SiteLoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  if (await getSiteIdentity()) redirect('/account')
  const { next } = await searchParams
  return (
    <Container maxWidth="xs" sx={{ py: 6 }}>
      <SiteAuthForm mode="login" next={next} />
    </Container>
  )
}
