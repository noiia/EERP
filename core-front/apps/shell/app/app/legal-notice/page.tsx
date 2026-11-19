import Container from '@mui/material/Container'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { T } from '@eerp/core-front'
import { requireAuth } from '@/lib/session'
import { getLegalNotice } from '@/website/public-api'
import { LegalNoticeView } from '@/website/LegalNoticeView'

// The workspace's legal notice, readable by every ERP user (it is public anyway,
// so it is read from the public route — no settings permission needed).
export default async function ErpLegalNoticePage() {
  await requireAuth('/legal-notice')
  const legal = await getLegalNotice()
  return (
    <Container maxWidth="md" sx={{ py: 4 }}>
      <Stack spacing={3}>
        <Typography variant="h4" component="h1">
          <T text="Legal notice" />
        </Typography>
        {legal ? (
          <LegalNoticeView legal={legal} />
        ) : (
          <Typography color="text.secondary">
            <T text="No legal notice has been set yet." />
          </Typography>
        )}
      </Stack>
    </Container>
  )
}
