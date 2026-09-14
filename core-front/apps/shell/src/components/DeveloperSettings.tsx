'use client'
import { useState } from 'react'
import Link from 'next/link'
import Accordion from '@mui/material/Accordion'
import AccordionDetails from '@mui/material/AccordionDetails'
import AccordionSummary from '@mui/material/AccordionSummary'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Container from '@mui/material/Container'
import Divider from '@mui/material/Divider'
import List from '@mui/material/List'
import ListItem from '@mui/material/ListItem'
import ListItemText from '@mui/material/ListItemText'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { byPrefixAndName, FontAwesomeIcon, useT } from '@eerp/core-front'
import { seedDemoData, type SeedEntityResult } from '@/lib/dev-seed'

// Settings → Developer: dev-only tools for testing the software. Two
// collapsible sections (the same Accordion component Settings -> Global
// settings uses to host Colors/Reports, docs/adr/ADR-016-cron-scheduler.md):
// "Crons" on top, "Seed demo data" — the ORIGINAL content of this page,
// unchanged behavior — underneath. `isDev` mirrors the Server Action's own
// NODE_ENV guard (defense in depth — the button disables itself here, but
// the action refuses the write server-side regardless of what the client
// sends).
export default function DeveloperSettings({ isDev }: { isDev: boolean }) {
  const t = useT()
  const [seeding, setSeeding] = useState(false)
  const [results, setResults] = useState<SeedEntityResult[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function onSeed() {
    setSeeding(true)
    setError(null)
    setResults(null)
    const outcome = await seedDemoData()
    setSeeding(false)
    if (!outcome.ok) {
      setError(outcome.message)
      return
    }
    setResults(outcome.results)
  }

  return (
    <Container maxWidth="md" sx={{ py: 6 }}>
      <Stack spacing={3}>
        <Stack spacing={1}>
          <Typography variant="h4" component="h1">
            {t('Developer')}
          </Typography>
          <Typography color="text.secondary">
            {t('Tools for testing the software against realistic data.')}
          </Typography>
        </Stack>

        <Accordion defaultExpanded disableGutters>
          <AccordionSummary
            expandIcon={<FontAwesomeIcon icon={byPrefixAndName.fas['chevron-down']} />}
          >
            <Typography variant="subtitle1">{t('Crons')}</Typography>
          </AccordionSummary>
          <AccordionDetails>
            <Stack spacing={2}>
              <Typography variant="body2" color="text.secondary">
                {t(
                  'Background scheduled actions — go code registered under an id, run on a schedule as a chosen user, with a full execution history and downloadable logs. Manage them as a normal list, kanban, calendar and graph, exactly like any other entity.',
                )}
              </Typography>
              <Stack direction="row">
                <Button variant="outlined" component={Link} href="/cron">
                  {t('Manage crons')}
                </Button>
              </Stack>
            </Stack>
          </AccordionDetails>
        </Accordion>

        <Accordion defaultExpanded disableGutters>
          <AccordionSummary
            expandIcon={<FontAwesomeIcon icon={byPrefixAndName.fas['chevron-down']} />}
          >
            {/* "Demo data", not "Seed demo data": the section title must not
                collide with the action Button's own accessible name below —
                MUI's AccordionSummary toggle is itself a <button> whose
                accessible name is this heading's text. */}
            <Typography variant="subtitle1">{t('Demo data')}</Typography>
          </AccordionSummary>
          <AccordionDetails>
            <Stack spacing={3}>
              <Stack spacing={1}>
                <Typography variant="body2" color="text.secondary">
                  {t(
                    'Creates a batch of fake contacts, CRM opportunities, and tags through the normal entity API, for exercising the UI with realistic-looking data.',
                  )}
                </Typography>
                <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
                  <Button variant="contained" onClick={() => void onSeed()} disabled={!isDev || seeding}>
                    {seeding ? t('Seeding…') : t('Seed demo data')}
                  </Button>
                  {seeding && <CircularProgress size={20} />}
                </Stack>
                {!isDev && (
                  <Typography variant="body2" color="text.secondary">
                    {t('Seeding demo data is only available outside production.')}
                  </Typography>
                )}
              </Stack>

              {error && <Alert severity="error">{error}</Alert>}

              {results && (
                <Stack spacing={1}>
                  <Divider />
                  <Typography variant="subtitle1">{t('Results')}</Typography>
                  <List dense disablePadding>
                    {results.map((r) => (
                      <ListItem key={r.entity} disableGutters>
                        <ListItemText
                          primary={`${r.entity}: ${r.created} ${t('created')}${
                            r.failed > 0 ? `, ${r.failed} ${t('failed')}` : ''
                          }`}
                          secondary={r.errors.length > 0 ? r.errors.join(' · ') : undefined}
                        />
                      </ListItem>
                    ))}
                  </List>
                </Stack>
              )}
            </Stack>
          </AccordionDetails>
        </Accordion>
      </Stack>
    </Container>
  )
}
