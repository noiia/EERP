import type { ReactNode } from 'react'
import Box from '@mui/material/Box'
import Container from '@mui/material/Container'
import Link from '@mui/material/Link'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { T } from '@eerp/core-front'
import { SiteHeader } from '@/website/SiteHeader'
import { SiteFooterPrefs, SitePrefsSync } from '@/website/SitePrefs'
import { getSitePreferences } from '@/website/site-preferences'
import { getLegalNotice, getMenuPages } from '@/website/public-api'
import { getIdentity } from '@/lib/session'
import { getSiteIdentity } from '@/lib/site-session'

// Public website chrome. The ERP link only shows when a staff (ERP) session exists;
// the footer's legal notice link only once one is set. The visitor's language and
// currency (footer pickers) are resolved here, once per request.
export default async function SiteLayout({ children }: { children: ReactNode }) {
  const [menu, siteUser, erpUser, legal, site] = await Promise.all([
    getMenuPages(), getSiteIdentity(), getIdentity(), getLegalNotice().catch(() => null), getSitePreferences(),
  ])
  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <SitePrefsSync prefs={site.prefs} localization={site.localization} />
      <SiteHeader menu={menu} signedIn={!!siteUser} staff={!!erpUser} />
      <Box component="main" sx={{ flex: 1 }}>{children}</Box>
      <Container component="footer" maxWidth="lg" sx={{ py: 3 }}>
        <Stack direction="row" spacing={2} sx={{ flexWrap: 'wrap', alignItems: 'center', rowGap: 1 }}>
          <SiteFooterPrefs locales={site.locales} currencies={site.localization.currencies} />
          <Typography variant="body2" color="text.secondary"><T text="All rights reserved." /></Typography>
          {legal && (
            <Link href="/legal-notice" variant="body2" color="text.secondary"><T text="Legal notice" /></Link>
          )}
        </Stack>
      </Container>
    </Box>
  )
}
