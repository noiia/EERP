import Box from '@mui/material/Box'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { T } from '@eerp/core-front'
import type { LegalNotice } from '@/lib/website-settings'

type Row = { label: string; value: string; href?: string }

function Section({ title, rows }: { title: string; rows: Row[] }) {
  const shown = rows.filter((r) => r.value)
  if (shown.length === 0) return null
  return (
    <Box component="section">
      <Typography variant="h5" component="h2" gutterBottom>
        <T text={title} />
      </Typography>
      <Box
        component="dl"
        sx={{
          m: 0,
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', sm: 'minmax(160px, max-content) 1fr' },
          columnGap: 3,
          rowGap: 1,
        }}
      >
        {shown.map((r) => (
          <Box key={r.label} sx={{ display: 'contents' }}>
            <Typography component="dt" color="text.secondary">
              <T text={r.label} />
            </Typography>
            <Typography
              component="dd"
              sx={{ m: 0, whiteSpace: 'pre-line', overflowWrap: 'anywhere' }}
            >
              {r.href ? <a href={r.href}>{r.value}</a> : r.value}
            </Typography>
          </Box>
        ))}
      </Box>
    </Box>
  )
}

/** The legal notice page body, shared by the public site and the ERP. Plain text
 * only: values are rendered as text, never as HTML. */
export function LegalNoticeView({ legal }: { legal: LegalNotice }) {
  return (
    <Stack spacing={4}>
      <Section
        title="Publisher"
        rows={[
          { label: 'Company name', value: legal.company_name },
          { label: 'Legal form', value: legal.legal_form },
          { label: 'Share capital', value: legal.share_capital },
          { label: 'Registered office', value: legal.address },
          { label: 'Registration (SIRET / RCS)', value: legal.registration },
          { label: 'VAT number', value: legal.vat_number },
          { label: 'Publication director', value: legal.publication_director },
          {
            label: 'Email',
            value: legal.contact_email,
            href: legal.contact_email ? `mailto:${legal.contact_email}` : undefined,
          },
          { label: 'Phone', value: legal.contact_phone },
        ]}
      />
      <Section
        title="Hosting"
        rows={[
          { label: 'Host', value: legal.host_name },
          { label: 'Address', value: legal.host_address },
          { label: 'Phone', value: legal.host_phone },
        ]}
      />
      {legal.extra_text && (
        <Typography sx={{ whiteSpace: 'pre-line' }}>{legal.extra_text}</Typography>
      )}
    </Stack>
  )
}
