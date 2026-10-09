import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import Container from '@mui/material/Container'
import Typography from '@mui/material/Typography'
import { T } from '@eerp/core-front'
import { getLegalNotice } from '@/website/public-api'
import { LegalNoticeView } from '@/website/LegalNoticeView'

export const metadata: Metadata = { title: 'Legal notice' }

// The site's legal notice (Settings → Website → Legal notice); 404 until set.
export default async function LegalNoticePage() {
  const legal = await getLegalNotice()
  if (!legal) notFound()
  return (
    <Container maxWidth="md" sx={{ py: 6 }}>
      <Typography variant="h3" component="h1" gutterBottom>
        <T text="Legal notice" />
      </Typography>
      <LegalNoticeView legal={legal} />
    </Container>
  )
}
