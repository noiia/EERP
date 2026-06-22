'use client'
import Link from 'next/link'
import Box from '@mui/material/Box'
import Card from '@mui/material/Card'
import CardActionArea from '@mui/material/CardActionArea'
import Chip from '@mui/material/Chip'
import Container from '@mui/material/Container'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import type { MenuModule } from '@eerp/core-front'

// The landing menu: the installed applications and their navigable views, rendered as
// links. A Client Component because each card uses MUI's `component={Link}` (a function
// prop MUI can't receive across the RSC boundary). Purely presentational — no async, no
// data access, serializable props — so it stays trivially unit-testable; the page
// (page.tsx, a Server Component) resolves the session and feeds the registry menu here.

export interface MenuProps {
  /** Installed modules with their navigable views, already permission-filtered. */
  menu: MenuModule[]
  /** Resolved user id, shown in the header. */
  userId: string
}

/** "crm" -> "Crm", "/crm/contacts" -> "Contacts" — a readable label from a slug. */
function titleize(slug: string): string {
  return slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

function viewLabel(path: string): string {
  const segments = path.split('/').filter(Boolean)
  return titleize(segments[segments.length - 1] ?? path)
}

export default function Menu({ menu, userId }: MenuProps) {
  return (
    <Container sx={{ py: 6 }}>
      <Stack spacing={1} sx={{ mb: 4 }}>
        <Typography variant="h4" component="h1">
          Applications
        </Typography>
        <Typography color="text.secondary">Signed in as {userId}</Typography>
      </Stack>

      {menu.length === 0 ? (
        <Typography color="text.secondary">
          No applications are available for your account.
        </Typography>
      ) : (
        <Stack spacing={4}>
          {menu.map((module) => (
            <Box key={module.name} component="section">
              <Typography variant="h6" component="h2" gutterBottom>
                {titleize(module.name)}
              </Typography>
              <Box
                sx={{
                  display: 'grid',
                  gap: 2,
                  gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', md: 'repeat(3, 1fr)' },
                }}
              >
                {module.routes.map((route) => (
                  <Card key={route.path} variant="outlined">
                    <CardActionArea component={Link} href={route.path} sx={{ p: 2 }}>
                      <Stack spacing={1}>
                        <Typography variant="subtitle1">{viewLabel(route.path)}</Typography>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          <Chip size="small" label={route.descriptor.viewType} />
                          <Typography variant="body2" color="text.secondary">
                            {route.path}
                          </Typography>
                        </Box>
                      </Stack>
                    </CardActionArea>
                  </Card>
                ))}
              </Box>
            </Box>
          ))}
        </Stack>
      )}
    </Container>
  )
}
