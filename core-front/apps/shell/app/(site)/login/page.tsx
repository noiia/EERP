import { redirect } from 'next/navigation'
import Container from '@mui/material/Container'
import Link from '@mui/material/Link'
import { erpPath, T } from '@eerp/core-front'
import { getSiteIdentity } from '@/lib/site-session'
import { safeNext } from '@/website/urls'
import { SiteAuthForm } from '@/website/SiteAuthForm'

export default async function SiteLoginPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const { next: raw } = await searchParams
  const next = Array.isArray(raw) ? raw[0] : raw
  if (await getSiteIdentity()) redirect(safeNext(next, '/account'))
  return (
    <Container maxWidth="xs" sx={{ py: 6 }}>
      <SiteAuthForm mode="login" next={next} />
      {/* Old /login bookmarks (the pre-/app ERP sign-in) land on this visitor page. */}
      <Link href={erpPath('/login')} variant="body2" sx={{ display: 'block', mt: 3, textAlign: 'center' }}>
        <T text="Staff sign-in" />
      </Link>
    </Container>
  )
}
