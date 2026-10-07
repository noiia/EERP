'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import Accordion from '@mui/material/Accordion'
import AccordionDetails from '@mui/material/AccordionDetails'
import AccordionSummary from '@mui/material/AccordionSummary'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import CircularProgress from '@mui/material/CircularProgress'
import Container from '@mui/material/Container'
import Divider from '@mui/material/Divider'
import FormControlLabel from '@mui/material/FormControlLabel'
import FormGroup from '@mui/material/FormGroup'
import List from '@mui/material/List'
import ListItem from '@mui/material/ListItem'
import ListItemText from '@mui/material/ListItemText'
import Radio from '@mui/material/Radio'
import RadioGroup from '@mui/material/RadioGroup'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { byPrefixAndName, erpPath, FontAwesomeIcon, useT } from '@eerp/core-front'
import { getSeedGroups, seedDemoData, type SeedEntityResult, type SeedGroup, type SeedVolume } from '@/lib/dev-seed'

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
  const [volume, setVolume] = useState<SeedVolume>('light')
  const [seeding, setSeeding] = useState(false)
  const [results, setResults] = useState<SeedEntityResult[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Full volume: its groups (null until loaded) and the ones the user ticked —
  // every unseeded group by default.
  const [groups, setGroups] = useState<SeedGroup[] | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())

  async function loadGroups() {
    const list = await getSeedGroups()
    setGroups(list ?? [])
    setPicked(new Set((list ?? []).filter((g) => !g.seeded).map((g) => g.key)))
  }
  useEffect(() => {
    if (volume === 'full' && groups === null) void loadGroups()
  }, [volume, groups])

  // What a run would seed: the ticked groups plus everything they depend on
  // (transitively), minus groups already seeded. A dependency stays ticked and
  // locked while a ticked group needs it, as Go would seed it anyway.
  const byKey = new Map((groups ?? []).map((g) => [g.key, g]))
  const effective = new Set<string>()
  const include = (key: string) => {
    const g = byKey.get(key)
    if (!g || g.seeded || effective.has(key)) return
    effective.add(key)
    g.deps.forEach(include)
  }
  picked.forEach(include)
  const neededBy = (key: string) =>
    (groups ?? []).filter((g) => effective.has(g.key) && g.deps.includes(key)).map((g) => t(g.label))
  const toSeed = (groups ?? []).filter((g) => effective.has(g.key)).map((g) => g.key)
  const toggle = (key: string) =>
    setPicked((p) => {
      const next = new Set(p)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  async function onSeed() {
    setSeeding(true)
    setError(null)
    setResults(null)
    const outcome = volume === 'full' ? await seedDemoData('full', toSeed) : await seedDemoData(volume)
    setSeeding(false)
    if (!outcome.ok) {
      setError(outcome.message)
      return
    }
    setResults(outcome.results)
    if (volume === 'full') void loadGroups() // the seeded groups are now done
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
                <Button variant="outlined" component={Link} href={erpPath('/cron')}>
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
                <RadioGroup
                  aria-label={t('Volume')}
                  value={volume}
                  onChange={(e) => setVolume(e.target.value as SeedVolume)}
                >
                  <FormControlLabel
                    value="light"
                    control={<Radio />}
                    label={
                      <Stack>
                        <Typography variant="body2">{t('Light')}</Typography>
                        <Typography variant="caption" color="text.secondary">
                          {t(
                            'Creates a batch of fake contacts, CRM opportunities, and tags through the normal entity API, for exercising the UI with realistic-looking data.',
                          )}
                        </Typography>
                      </Stack>
                    }
                  />
                  <FormControlLabel
                    value="full"
                    control={<Radio />}
                    label={
                      <Stack>
                        <Typography variant="body2">{t('Full')}</Typography>
                        <Typography variant="caption" color="text.secondary">
                          {t(
                            'About 100,000 rows each of contacts, CRM leads, products, variants, quotes, invoices, rent receipts and event bookings, with lines, several taxes and companies, plus graph views with calculated fields on every list over 10,000 rows. Pick the groups below; each is seeded once per workspace, and all of them take about half a minute.',
                          )}
                        </Typography>
                      </Stack>
                    }
                  />
                </RadioGroup>
                {volume === 'full' && groups && (
                  <FormGroup sx={{ pl: 4 }} aria-label={t('Groups to seed')}>
                    {groups.map((g) => {
                      const needers = g.seeded ? [] : neededBy(g.key)
                      const locked = g.seeded || needers.length > 0
                      return (
                        <FormControlLabel
                          key={g.key}
                          control={
                            <Checkbox
                              size="small"
                              checked={g.seeded || effective.has(g.key)}
                              disabled={locked || seeding}
                              onChange={() => toggle(g.key)}
                            />
                          }
                          label={
                            <Typography variant="body2">
                              {t(g.label)}
                              {g.seeded ? (
                                <Typography component="span" variant="caption" color="text.secondary">{` — ${t('already seeded')}`}</Typography>
                              ) : needers.length > 0 ? (
                                <Typography component="span" variant="caption" color="text.secondary">{` — ${t('needed by')} ${needers.join(', ')}`}</Typography>
                              ) : null}
                            </Typography>
                          }
                        />
                      )
                    })}
                  </FormGroup>
                )}
                <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
                  <Button
                    variant="contained"
                    onClick={() => void onSeed()}
                    disabled={!isDev || seeding || (volume === 'full' && toSeed.length === 0)}
                  >
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
