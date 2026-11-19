'use client'

import { useEffect, useState } from 'react'
import { Alert, Box, Button, MenuItem, TextField, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material'
import { useTheme } from '@mui/material/styles'
import { useRouter } from 'next/navigation'
import { erpPath, unwrapActionResult, usePhone, useT, type EntityListOptions } from '@eerp/core-front'
import { listRecords } from '@/lib/relation-actions'
import { addDaysIso, loadLevel, mondayOf, spreadWorkload } from './workload'

const PAGE_SIZE = 200
/** Hard read cap: loops page until a short page, and stops at 1000. */
const READ_CAP = 1000
/** Capacity a cell compares against when the user has no project_capacity row. */
const DEFAULT_CAPACITY = 40
/** in[] chunks: 100 ids per relation read (query-length bound). */
const CHUNK = 100

/** An open task in the window, as the list endpoint returns it (the window
 * filters keep date_start and deadline set, and planned hours above 0). */
type TaskRow = { id: string; date_start: string; deadline: string; planned_hours: number }
type Project = { id: string; name: string }
type User = { id: string; email: string }

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
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

/** Show the hours of a cell (integers stay integers, 2.5 stays "2.5"). */
function cellText(hours: number): string {
  return String(Math.round(hours * 100) / 100)
}

export function Workload() {
  const t = useT()
  const theme = useTheme()
  const phone = usePhone()
  const router = useRouter()
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [projectFilter, setProjectFilter] = useState('')
  const [rows, setRows] = useState<{ key: string; label: string; hours: number[]; capacity: number }[] | null>(null)
  const [weeks, setWeeks] = useState<string[]>([])
  const [capped, setCapped] = useState(false)
  const [error, setError] = useState('')
  // 8 weeks on desktop, 4 on a phone (the user column stays sticky, the weeks
  // scroll inside their own box).
  const weekCount = phone ? 4 : 8

  async function load() {
    setError('')
    try {
      const windowStart = mondayOf(new Date())
      const windowWeeks = Array.from({ length: weekCount }, (_, i) => addDaysIso(windowStart, i * 7))
      const windowEnd = addDaysIso(windowWeeks[windowWeeks.length - 1], 7)
      // Open tasks with planned hours overlapping the window (both dates set by
      // the gte/lt window filters, hours above 0).
      const [projectsRes, tasksRes] = await Promise.all([
        pageAll<Project>('project', { order: 'name' }),
        pageAll<TaskRow>('project_task', {
          filter: { closed: 'false', ...(projectFilter ? { project_id: projectFilter } : {}) },
          gte: { deadline: windowStart },
          lt: { date_start: windowEnd },
          gt: { planned_hours: '0' },
          order: 'date_start',
        }),
      ])
      setProjects(projectsRes.records)
      const { records: tasks, capped: isCapped } = tasksRes
      setCapped(isCapped)
      setWeeks(windowWeeks)
      const [assignees, capacitiesRes] = await Promise.all([
        chunkedAll<{ task_id: string; user_id: string }>('project_task_user', 'task_id', tasks.map((x) => x.id)),
        pageAll<{ user_id: string; hours_per_week: number }>('project_capacity', {}),
      ])
      const capacities = capacitiesRes.records
      const byTask = new Map<string, string[]>()
      for (const a of assignees) {
        const list = byTask.get(a.task_id) ?? []
        list.push(a.user_id)
        byTask.set(a.task_id, list)
      }
      const spread = spreadWorkload(
        tasks.map((x) => ({
          id: x.id,
          start: String(x.date_start).slice(0, 10),
          end: String(x.deadline).slice(0, 10),
          hours: Number(x.planned_hours),
          assignees: byTask.get(x.id) ?? [],
        })),
        windowWeeks,
      )
      const emails = new Map<string, string>()
      if (byTask.size > 0) {
        const ids = [...new Set(assignees.map((a) => a.user_id))]
        for (const u of await chunkedAll<User>('users', 'id', ids)) emails.set(u.id, u.email)
      }
      const capacityOf = new Map(capacities.map((c) => [c.user_id, Number(c.hours_per_week)]))
      const userKeys = [...spread.keys()].filter((k) => k !== '').sort((a, b) => (emails.get(a) ?? a).localeCompare(emails.get(b) ?? b))
      setRows([
        ...userKeys.map((k) => ({
          key: k,
          label: emails.get(k) ?? k,
          hours: spread.get(k) ?? new Array(windowWeeks.length).fill(0),
          capacity: capacityOf.get(k) ?? DEFAULT_CAPACITY,
        })),
        { key: '', label: t('Unassigned'), hours: spread.get('') ?? new Array(windowWeeks.length).fill(0), capacity: DEFAULT_CAPACITY },
      ])
    } catch (e) {
      setRows([])
      setWeeks([])
      setError(errorMessage(e))
    }
  }

  useEffect(() => {
    void load()
  }, [projectFilter, weekCount])

  if (rows === null || projects === null) {
    return (
      <Box sx={{ p: 4 }}>
        <Typography variant="h4" component="h1">
          {t('Workload')}
        </Typography>
      </Box>
    )
  }

  const sticky = { position: 'sticky', left: 0, zIndex: 1, backgroundColor: theme.palette.background.paper } as const
  const cellColor = (hours: number, capacity: number) => {
    const level = loadLevel(hours, capacity)
    if (level === 'warning') return theme.palette.warning.main
    if (level === 'error') return theme.palette.error.main
    return 'transparent'
  }

  return (
    <Box sx={{ p: { xs: 2, md: 4 } }}>
      <Typography variant="h4" component="h1">
        {t('Workload')}
      </Typography>
      <Box sx={{ my: 2, maxWidth: { xs: '100%', md: 320 } }}>
        <TextField
          select
          size="small"
          label={t('Project')}
          value={projectFilter}
          onChange={(e) => setProjectFilter(String(e.target.value))}
        >
          <MenuItem value="">{t('All projects')}</MenuItem>
          {projects.map((p) => (
            <MenuItem key={p.id} value={p.id}>
              {p.name}
            </MenuItem>
          ))}
        </TextField>
      </Box>
      {error ? <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert> : null}
      {capped ? (
        <Typography variant="caption" color="text.secondary">
          {t('First 1000 shown')}
        </Typography>
      ) : null}
      <Box sx={{ mt: 2 }} style={{ overflowX: 'auto' }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell style={sticky}>{t('User')}</TableCell>
              {weeks.map((w) => (
                <TableCell key={w} align="center">
                  {w}
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.key || 'unassigned'} aria-label={row.label}>
                <TableCell style={sticky}>{row.label}</TableCell>
                {weeks.map((w, i) => {
                  const hours = row.hours[i] ?? 0
                  if (hours <= 0) return <TableCell key={w} align="center" />
                  const style = { backgroundColor: cellColor(hours, row.capacity) }
                  if (row.key === '') {
                    // The Unassigned row has no user to filter the tasks by.
                    return (
                      <TableCell key={w} align="center" style={style}>
                        {cellText(hours)}
                      </TableCell>
                    )
                  }
                  return (
                    <TableCell key={w} align="center" sx={{ p: 0.5 }}>
                      <Button
                        size="small"
                        aria-label={`${row.label} ${w}`}
                        style={style}
                        onClick={() => router.push(erpPath(`/project/tasks?filter[assignees]=${row.key}`))}
                      >
                        {cellText(hours)}
                      </Button>
                    </TableCell>
                  )
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Box>
    </Box>
  )
}
