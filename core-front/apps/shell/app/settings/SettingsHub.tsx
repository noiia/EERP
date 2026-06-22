'use client'
import Link from 'next/link'
import Box from '@mui/material/Box'
import Card from '@mui/material/Card'
import CardActionArea from '@mui/material/CardActionArea'
import Container from '@mui/material/Container'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'

// The main settings page: the catalog of setting sections, rendered as navigable
// cards (the same shape as the application menu). Purely presentational — the page
// (a Server Component) gates auth and feeds the sections here — so it stays trivially
// unit-testable. New setting areas are one entry in SETTINGS_SECTIONS.

export interface SettingsSection {
  path: string
  title: string
  description: string
}

/** The installed settings sections. Appearance ships first; more land here later. */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    path: '/settings/appearance',
    title: 'Appearance',
    description: 'Brand colors and light/dark mode for the whole interface.',
  },
] as const

export default function SettingsHub({
  sections = SETTINGS_SECTIONS,
}: {
  sections?: readonly SettingsSection[]
}) {
  return (
    <Container sx={{ py: 6 }}>
      <Stack spacing={1} sx={{ mb: 4 }}>
        <Typography variant="h4" component="h1">
          Settings
        </Typography>
        <Typography color="text.secondary">Manage your workspace preferences.</Typography>
      </Stack>

      <Box
        sx={{
          display: 'grid',
          gap: 2,
          gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', md: 'repeat(3, 1fr)' },
        }}
      >
        {sections.map((section) => (
          <Card key={section.path} variant="outlined">
            <CardActionArea component={Link} href={section.path} sx={{ p: 2, height: '100%' }}>
              <Stack spacing={1}>
                <Typography variant="subtitle1">{section.title}</Typography>
                <Typography variant="body2" color="text.secondary">
                  {section.description}
                </Typography>
              </Stack>
            </CardActionArea>
          </Card>
        ))}
      </Box>
    </Container>
  )
}
