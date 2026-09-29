import type { ReactNode } from 'react'
import Box from '@mui/material/Box'
import Container from '@mui/material/Container'
import Typography from '@mui/material/Typography'
import { T } from '@eerp/core-front'
import { SiteHeader } from '@/website/SiteHeader'
import { getMenuPages } from '@/website/public-api'
import { getIdentity } from '@/lib/session'
import { getSiteIdentity } from '@/lib/site-session'

// Public website chrome. The ERP link only shows when a staff (ERP) session exists.
export default async function SiteLayout({ children }: { children: ReactNode }) {
  const [menu, siteUser, erpUser] = await Promise.all([getMenuPages(), getSiteIdentity(), getIdentity()])
  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <SiteHeader menu={menu} signedIn={!!siteUser} staff={!!erpUser} />
      <Box component="main" sx={{ flex: 1 }}>{children}</Box>
      <Container component="footer" maxWidth="lg" sx={{ py: 3 }}>
        <Typography variant="body2" color="text.secondary"><T text="All rights reserved." /></Typography>
      </Container>
    </Box>
  )
}
