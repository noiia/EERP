'use client'
import Link from 'next/link'
import Box from '@mui/material/Box'
import Card from '@mui/material/Card'
import CardActionArea from '@mui/material/CardActionArea'
import Container from '@mui/material/Container'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { useT } from '@eerp/core-front'

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
    path: '/settings/account',
    title: 'Account',
    description: 'Your personal preferences, like the display language.',
  },
  {
    path: '/settings/company',
    title: 'Company',
    description: 'The companies hosted on this workspace and their profiles.',
  },
  {
    path: '/settings/appearance',
    title: 'Global settings',
    description: 'Colors, PDF report layout, and more.',
  },
  {
    path: '/settings/translations',
    title: 'Translations',
    description: 'Workspace default language, plus the translations modules provide.',
  },
  {
    path: '/settings/apps',
    title: 'Apps',
    description: 'Installed applications and their settings.',
  },
  {
    path: '/settings/users',
    title: 'Users',
    description: 'User accounts and roles of the workspace.',
  },
  {
    path: '/settings/developer',
    title: 'Developer',
    description: 'Seed the workspace with fake data for testing.',
  },
] as const

export default function SettingsHub({
  sections = SETTINGS_SECTIONS,
}: {
  sections?: readonly SettingsSection[]
}) {
  // Section titles/descriptions are gettext msgids — the shell ships their catalogs
  // in apps/shell/i18n/*.po, so the hub localizes without touching SETTINGS_SECTIONS.
  const t = useT()
  return (
    // maxWidth={false}: matches Menu.tsx (the same card-grid shape) — the page's
    // width bound is RootLayout's pageInsetX/pageInsetY inset, not MUI's own "lg" cap.
    <Container maxWidth={false} sx={{ py: 6 }}>
      <Stack spacing={1} sx={{ mb: 4 }}>
        <Typography variant="h4" component="h1">
          {t('Settings')}
        </Typography>
        <Typography color="text.secondary">{t('Manage your workspace preferences.')}</Typography>
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
                <Typography variant="subtitle1">{t(section.title)}</Typography>
                <Typography variant="body2" color="text.secondary">
                  {t(section.description)}
                </Typography>
              </Stack>
            </CardActionArea>
          </Card>
        ))}
      </Box>
    </Container>
  )
}
