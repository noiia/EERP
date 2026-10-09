'use client'
import Link from 'next/link'
import Card from '@mui/material/Card'
import CardActionArea from '@mui/material/CardActionArea'
import Container from '@mui/material/Container'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { T, erpPath } from '@eerp/core-front'

// Client Component: `CardActionArea component={Link}` can't cross the Server/Client
// boundary as a prop from the page (Next: "Functions cannot be passed directly to
// Client Components"), same reason as AppsList.
const PAGES = [
  { path: '/settings/website/published', title: 'Published data', description: 'Which tables and columns the public website may read.' },
  { path: '/settings/website/routing', title: 'Routing', description: 'Serve the website from a path or its own domain.' },
  { path: '/settings/website/legal', title: 'Legal notice', description: 'The publisher and host details shown on the website and in the ERP.' },
  { path: '/settings/website/security-txt', title: 'security.txt', description: 'How security researchers can reach you (RFC 9116).' },
  { path: '/settings/website/robots-txt', title: 'robots.txt', description: 'What search engines may crawl.' },
  { path: '/settings/website/users', title: 'Website users', description: 'Visitor accounts registered on the website.' },
  { path: '/settings/website/outbox', title: 'Outgoing emails', description: 'Booking and account emails, their delivery status, and retries.' },
] as const

export default function WebsiteHub() {
  return (
    <Container maxWidth={false} sx={{ py: 4 }}>
      <Stack spacing={3}>
        <Typography variant="h4" component="h1">
          <T text="Website" />
        </Typography>
        {PAGES.map((p) => (
          <Card key={p.path} variant="outlined">
            <CardActionArea component={Link} href={erpPath(p.path)} sx={{ p: 2 }}>
              <Typography variant="subtitle1">
                <T text={p.title} />
              </Typography>
              <Typography variant="body2" color="text.secondary">
                <T text={p.description} />
              </Typography>
            </CardActionArea>
          </Card>
        ))}
      </Stack>
    </Container>
  )
}
