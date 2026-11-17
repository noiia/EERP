'use client'

import { useEffect, useState } from 'react'
import { Alert, Box, Card, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material'
import { useRouter } from 'next/navigation'
import { erpPath, unwrapActionResult, useGraphPalette, usePhone, useT, type EntityListOptions } from '@eerp/core-front'
import { aggregateEntity } from '@/lib/graph-actions'
import { listRecords } from '@/lib/relation-actions'

const PAGE_SIZE = 200
/** Hard read cap: loops page until a short page, and stops at 1000. */
const READ_CAP = 1000
/** in[] chunks: 100 ids per relation read (query-length bound). */
const CHUNK = 100

/** A visible active project, as the list endpoint returns it. */
type ProjectRow = {
  id: string
  name: string
  manager_id: string | null
  task_count: number
  planned_hours: number
  spent_hours: number
  date_end: string | null
}
type User = { id: string; email: string }
type CountRow = { group?: string; value: number }
type Band = 'red' | 'amber' | 'green' | 'none'

/** One project's chart point and table row. */
type PortfolioRow = {
  id: string
  name: string
  manager: string
  progress: number
  planned: number
  spent: number
  end: string | null
  late: boolean
  band: Band
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function toIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Page through a list endpoint until a short page, capped at READ_CAP rows
 * (the rest is dropped). capped reports that the read hit the cap — at
 * exactly READ_CAP rows the server may hold more, so the caption still shows.
 */
async function pageAll<T>(
  entity: string,
  base: Omit<EntityListOptions, 'page' | 'pageSize'>,
): Promise<{ records: T[]; capped: boolean }> {
  const all: T[] = []
  for (let page = 1; ; page += 1) {
    const rows = unwrapActionResult(await listRecords(entity, { ...base, page, pageSize: PAGE_SIZE })) as T[]
    all.push(...rows)
    if (rows.length < PAGE_SIZE || all.length >= READ_CAP) break
  }
  return { records: all.slice(0, READ_CAP), capped: all.length >= READ_CAP }
}

/** Read every row the `in` query matches, 100 ids per request. */
async function chunkedAll<T>(entity: string, idField: string, ids: string[]): Promise<T[]> {
  const all: T[] = []
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { records } = await pageAll<T>(entity, { in: { [idField]: ids.slice(i, i + CHUNK) } })
    all.push(...records)
  }
  return all
}

/** A `?aggregate=count&group=project_id` answer as a per-project count. */
function countBy(rows: CountRow[] | null): Map<string, number> {
  const map = new Map<string, number>()
  for (const row of rows ?? []) {
    const key = String(row.group ?? '')
    map.set(key, (map.get(key) ?? 0) + Number(row.value))
  }
  return map
}

export function Portfolio() {
  const t = useT()
  const phone = usePhone()
  const router = useRouter()
  const { categorical, chrome } = useGraphPalette()
  // The criticity bands' palette slots: red = 6th, amber = 3rd, green = 2nd
  // color of the categorical palette (the validated dataviz ordering).
  const bandColor = (band: Band) =>
    band === 'red' ? categorical[5] : band === 'amber' ? categorical[2] : band === 'green' ? categorical[1] : chrome.mutedInk
  const [rows, setRows] = useState<PortfolioRow[] | null>(null)
  const [capped, setCapped] = useState(false)
  const [error, setError] = useState('')

  async function load() {
    setError('')
    try {
      const { records: projects, capped: isCapped } = await pageAll<ProjectRow>('project', {
        filter: { active: 'true' },
        order: 'name',
      })
      setCapped(isCapped)
      // Done tasks and the risk criticity bands, per project: red > 12,
      // amber 4..12, green <= 4 (the third band separates "some green risks"
      // from "no risks at all").
      const [done, red, amber, green] = await Promise.all([
        aggregateEntity('project_task', { aggregate: 'count', group: 'project_id' }, { filter: { closed: 'true' } }),
        aggregateEntity('project_risk', { aggregate: 'count', group: 'project_id' }, { gt: { criticity: '12' } }),
        aggregateEntity('project_risk', { aggregate: 'count', group: 'project_id' }, { gt: { criticity: '4' }, lte: { criticity: '12' } }),
        aggregateEntity('project_risk', { aggregate: 'count', group: 'project_id' }, { lte: { criticity: '4' } }),
      ])
      const doneBy = countBy(done)
      const redBy = countBy(red)
      const amberBy = countBy(amber)
      const greenBy = countBy(green)
      const managerIds = [...new Set(projects.map((p) => String(p.manager_id)).filter((id) => id.length > 0))]
      const managers = new Map<string, string>((await chunkedAll<User>('users', 'id', managerIds)).map((u) => [u.id, u.email]))
      const today = toIso(new Date())
      setRows(
        projects.map((p) => {
          const planned = Number(p.planned_hours)
          const spent = Number(p.spent_hours)
          const progress = p.task_count > 0 ? Math.min((doneBy.get(p.id) ?? 0) / p.task_count, 1) : 0
          const end = p.date_end ? String(p.date_end).slice(0, 10) : null
          const band: Band =
            (redBy.get(p.id) ?? 0) > 0 ? 'red' : (amberBy.get(p.id) ?? 0) > 0 ? 'amber' : (greenBy.get(p.id) ?? 0) > 0 ? 'green' : 'none'
          return {
            id: p.id,
            name: p.name,
            manager: p.manager_id ? (managers.get(p.manager_id) ?? p.manager_id) : '—',
            progress,
            planned,
            spent,
            end,
            late: end !== null && end < today && progress < 1,
            band,
          }
        }),
      )
    } catch (e) {
      setRows([])
      setError(errorMessage(e))
    }
  }

  useEffect(() => {
    void load()
  }, [])

  if (rows === null) {
    return (
      <Box sx={{ p: 4 }}>
        <Typography variant="h4" component="h1">
          {t('Portfolio')}
        </Typography>
      </Box>
    )
  }

  const openTasks = (id: string) => router.push(erpPath(`/project/tasks?filter[project_id]=${id}`))

  // Plain-SVG bubble chart: x = % tasks done, y = % hours used (0..200%),
  // size = planned hours, color = the project's worst risk band. The plot
  // area keeps 44px left for the y labels and 28px below for the x labels.
  const W = phone ? 400 : 560
  const H = 400
  const PLOT = { x0: 44, x1: W - 16, y0: 16, y1: H - 28 }
  const plotW = PLOT.x1 - PLOT.x0
  const plotH = PLOT.y1 - PLOT.y0
  const maxPlanned = Math.max(1, ...rows.map((r) => r.planned))
  const x = (progress: number) => PLOT.x0 + plotW * progress
  // hoursPct is the spent/planned ratio capped at 2 (= 200%), or 0 when there
  // are no planned hours (a hollow marker at the bottom axis).
  const y = (planned: number, spent: number) => PLOT.y1 - plotH * (planned > 0 ? Math.min(spent / planned, 2) / 2 : 0)
  const radius = (planned: number) => (planned > 0 ? 4 + 10 * Math.sqrt(planned / maxPlanned) : 4)

  const dot = (band: Band) => (
    <span
      title={band === 'none' ? t('No risks') : t(band)}
      style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', backgroundColor: bandColor(band) }}
    />
  )

  return (
    <Box sx={{ p: { xs: 2, md: 4 } }}>
      <Typography variant="h4" component="h1">
        {t('Portfolio')}
      </Typography>
      {error ? <Alert severity="error" sx={{ my: 2 }}>{error}</Alert> : null}
      {capped ? (
        <Typography variant="caption" color="text.secondary">
          {t('First 1000 shown')}
        </Typography>
      ) : null}
      <Box sx={{ mt: 2, maxWidth: phone ? '100%' : W }} style={phone ? { width: '100%', aspectRatio: '1 / 1' } : undefined}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('Portfolio chart')} style={{ width: '100%', height: 'auto', display: 'block' }}>
          {/* Axes (lines only: the bubbles are the chart's only circles). */}
          <line x1={PLOT.x0} y1={PLOT.y1} x2={PLOT.x1} y2={PLOT.y1} stroke={chrome.baseline} />
          <line x1={PLOT.x0} y1={PLOT.y0} x2={PLOT.x0} y2={PLOT.y1} stroke={chrome.baseline} />
          <text x={PLOT.x0} y={H - 10} fill={chrome.mutedInk} fontSize="10">
            0%
          </text>
          <text x={PLOT.x1} y={H - 10} fill={chrome.mutedInk} fontSize="10" textAnchor="end">
            100%
          </text>
          <text x={PLOT.x0 - 6} y={PLOT.y1 + 4} fill={chrome.mutedInk} fontSize="10" textAnchor="end">
            0%
          </text>
          <text x={PLOT.x0 - 6} y={PLOT.y0 + 4} fill={chrome.mutedInk} fontSize="10" textAnchor="end">
            200%
          </text>
          {rows.map((row) => (
            <circle
              key={row.id}
              cx={x(row.progress)}
              cy={y(row.planned, row.spent)}
              r={radius(row.planned)}
              fill={row.planned > 0 ? bandColor(row.band) : 'none'}
              stroke={row.planned > 0 ? undefined : chrome.mutedInk}
              strokeWidth={row.planned > 0 ? undefined : 1.5}
              opacity={row.planned > 0 ? 0.75 : undefined}
              aria-label={row.name}
              style={{ cursor: 'pointer' }}
              onClick={() => openTasks(row.id)}
            />
          ))}
        </svg>
      </Box>
      {phone ? (
        <Stack spacing={2} sx={{ mt: 2 }}>
          {rows.map((row) => (
            <Card
              key={row.id}
              component="article"
              aria-label={row.name}
              variant="outlined"
              style={{ width: '100%', cursor: 'pointer' }}
              onClick={() => openTasks(row.id)}
            >
              <Stack spacing={1} sx={{ p: 2 }}>
                <Stack direction="row" spacing={1} sx={{ justifyContent: 'space-between' }}>
                  <Typography variant="subtitle1">{row.name}</Typography>
                  {dot(row.band)}
                </Stack>
                <Typography variant="body2" color="text.secondary">
                  {t('Manager')}: {row.manager}
                </Typography>
                <Stack direction="row" spacing={1}>
                  <Typography variant="body2">{t('Progress')}:</Typography>
                  <Typography variant="body2">{Math.round(row.progress * 100) + '%'}</Typography>
                  {row.late ? (
                    <Typography variant="body2" color="error">
                      {t('Late')}
                    </Typography>
                  ) : null}
                </Stack>
                <Typography variant="body2" color="text.secondary">
                  {t('Planned hours')}: {row.planned > 0 ? `${row.spent} / ${row.planned}` : '—'}
                  {' · '}
                  {t('End date')}: {row.end ?? '—'}
                </Typography>
              </Stack>
            </Card>
          ))}
        </Stack>
      ) : (
        <Box sx={{ mt: 2 }} style={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t('Project')}</TableCell>
                <TableCell>{t('Manager')}</TableCell>
                <TableCell align="right">{t('Progress')}</TableCell>
                <TableCell align="right">{t('Planned hours')}</TableCell>
                <TableCell>{t('End date')}</TableCell>
                <TableCell />
                <TableCell>{t('Risk')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id} aria-label={row.name} style={{ cursor: 'pointer' }} onClick={() => openTasks(row.id)}>
                  <TableCell>{row.name}</TableCell>
                  <TableCell>{row.manager}</TableCell>
                  <TableCell align="right">{Math.round(row.progress * 100) + '%'}</TableCell>
                  <TableCell align="right">{row.planned > 0 ? `${row.spent} / ${row.planned}` : '—'}</TableCell>
                  <TableCell>{row.end ?? '—'}</TableCell>
                  <TableCell>{row.late ? t('Late') : ''}</TableCell>
                  <TableCell>{dot(row.band)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
      )}
    </Box>
  )
}
