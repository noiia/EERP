'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import {
  Alert,
  Box,
  Button,
  Card,
  Dialog,
  DialogContent,
  DialogTitle,
  List,
  ListItemButton,
  Stack,
  Tab,
  Tabs,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableFooter,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import { erpPath, unwrapActionResult, usePhone, useT, type EntityListOptions } from '@eerp/core-front'
import {
  createRelationRecord,
  getRecord,
  listRecords,
  removeRelationRecord,
  updateRelationRecord,
} from '@/lib/relation-actions'

/** One of my timesheet entries of the week, as the list endpoint returns it. */
type Entry = { id: string; task_id: string; user_id: string; date: string; hours: number }
/** A task row (open assigned task, or a task I logged that is no longer open). */
type Task = { id: string; name: string }

const PAGE_SIZE = 200
/** Hard read cap: loops page until a short page, and stops at 1000. */
const READ_CAP = 1000
const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function toIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
/** Monday of the week containing `d`, as ISO. */
function mondayOf(d: Date): string {
  const x = new Date(d)
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7))
  return toIso(x)
}
function addDaysIso(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number)
  return toIso(new Date(y, m - 1, d + days))
}
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
function formatHours(h: number): string {
  return String(h)
}

/**
 * Page through a list endpoint until a short page, capped at READ_CAP rows
 * (the rest is dropped, and the caller surfaces "First 1000 shown").
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
  const capped = all.length > READ_CAP
  return { records: capped ? all.slice(0, READ_CAP) : all, capped }
}

/** One editable grid cell: empty (create on write), one entry (update or
 * delete at 0), or several (read-only — a silent merge would lose data). */
type Cell =
  | { kind: 'empty'; entry: null; total: 0 }
  | { kind: 'single'; entry: Entry; total: number }
  | { kind: 'multi'; entry: null; total: number }

export function TimesheetWeek({ userId }: { userId: string }) {
  const t = useT()
  const phone = usePhone()
  const router = useRouter()
  const params = useSearchParams()

  // ?week=YYYY-MM-DD selects the week (normalized to its Monday); default is
  // the current week's Monday.
  const [weekStart, setWeekStart] = useState(() => {
    const param = params.get('week')
    return param && ISO_DATE.test(param) ? mondayOf(new Date(`${param}T00:00:00`)) : mondayOf(new Date())
  })
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [rows, setRows] = useState<Task[] | null>(null)
  const [capped, setCapped] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  // In-flight cell edits, keyed `${task_id}|${date}`: the value a refused
  // write must restore to.
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [selectedDay, setSelectedDay] = useState(0)
  const [adding, setAdding] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Task[] | null>(null)
  const [added, setAdded] = useState<Record<string, Task>>({})

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDaysIso(weekStart, i)), [weekStart])

  const load = useCallback(async () => {
    setError('')
    try {
      const [week, open] = await Promise.all([
        pageAll<Entry>('project_timesheet', {
          filter: { user_id: userId },
          gte: { date: weekStart },
          lt: { date: addDaysIso(weekStart, 7) },
        }),
        pageAll<Task>('project_task', { filter: { assignee: 'me', closed: 'false' }, order: 'name' }),
      ])
      setEntries(week.records)
      setCapped(week.capped || open.capped)
      // Rows: the tasks I logged that week (name order) first, then my open
      // assigned tasks that have no entry yet.
      const byId: Record<string, Task> = {}
      for (const task of open.records) byId[task.id] = task
      const logged = [...new Set(week.records.map((e) => e.task_id))]
      for (const id of logged) {
        if (byId[id]) continue
        try {
          byId[id] = unwrapActionResult(await getRecord('project_task', id)) as Task
        } catch {
          byId[id] = { id, name: id }
        }
      }
      const loggedRows = logged.map((id) => byId[id]).sort((a, b) => a.name.localeCompare(b.name))
      setRows([...loggedRows, ...open.records.filter((task) => !logged.includes(task.id))])
    } catch (e) {
      setEntries([])
      setRows([])
      setError(errorMessage(e))
    }
  }, [userId, weekStart])

  useEffect(() => {
    void load()
  }, [load])

  const allRows = useMemo(() => {
    if (!rows) return null
    const present = new Set(rows.map((r) => r.id))
    return [...rows, ...Object.values(added).filter((task) => !present.has(task.id))]
  }, [rows, added])

  const entryList = entries ?? []
  function entriesFor(taskId: string, date?: string): Entry[] {
    return entryList.filter((e) => e.task_id === taskId && (date === undefined || e.date === date))
  }
  function cellOf(taskId: string, date: string): Cell {
    const list = entriesFor(taskId, date)
    if (list.length === 0) return { kind: 'empty', entry: null, total: 0 }
    if (list.length === 1) return { kind: 'single', entry: list[0], total: list[0].hours }
    return { kind: 'multi', entry: null, total: list.reduce((s, e) => s + e.hours, 0) }
  }
  const rowTotal = (taskId: string) => entriesFor(taskId).reduce((s, e) => s + e.hours, 0)
  const colTotal = (date: string) => entryList.filter((e) => e.date === date).reduce((s, e) => s + e.hours, 0)
  const grandTotal = entryList.reduce((s, e) => s + e.hours, 0)

  function valueFor(taskId: string, date: string): string {
    const key = `${taskId}|${date}`
    if (edits[key] !== undefined) return edits[key]
    const cell = cellOf(taskId, date)
    return cell.entry ? formatHours(cell.entry.hours) : ''
  }

  async function commitCell(task: Task, date: string, value: string) {
    const key = `${task.id}|${date}`
    const cell = cellOf(task.id, date)
    const original = cell.entry ? formatHours(cell.entry.hours) : ''
    const hours = Number(value)
    if (!Number.isFinite(hours) || hours < 0 || value === original || cell.kind === 'multi') return
    setBusy(true)
    setError('')
    try {
      // user_id is filled by the server (my line); hours>0 is enforced there
      // too, so a refused write is a rejected ActionError.
      if (!cell.entry) {
        unwrapActionResult(await createRelationRecord('project_timesheet', { task_id: task.id, date, hours }))
      } else if (hours === 0) {
        unwrapActionResult(await removeRelationRecord('project_timesheet', cell.entry.id))
      } else {
        unwrapActionResult(await updateRelationRecord('project_timesheet', cell.entry.id, { hours }))
      }
      setEdits((prev) => {
        const next = { ...prev }
        delete next[key]
        return next
      })
      await load()
    } catch (e) {
      // Refused write: restore the cell and surface the reason.
      setEdits((prev) => ({ ...prev, [key]: original }))
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  function goWeek(deltaWeeks: number) {
    const next = addDaysIso(weekStart, deltaWeeks * 7)
    setWeekStart(next)
    router.replace(erpPath(`/project/timesheet-week?week=${next}`))
  }

  async function searchTasks() {
    const name = query.trim()
    if (!name) return
    try {
      // My visible open tasks (Go scopes the rows to what I can see), by name.
      setResults(unwrapActionResult(await listRecords('project_task', { filter: { closed: 'false' }, search: { name }, order: 'name' })) as Task[])
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  function addTask(task: Task) {
    setAdded((prev) => ({ ...prev, [task.id]: task }))
    setAdding(false)
    setQuery('')
    setResults(null)
  }

  const dayLabelOf = (date: string) => t(DAY_LABELS[days.indexOf(date)])

  // One editable cell: an input for empty/single cells, a read-only sum for
  // several (a merge would lose data — the tooltip points to Timesheets).
  function cellFor(task: Task, date: string) {
    const cell = cellOf(task.id, date)
    if (cell.kind === 'multi') {
      return (
        <Tooltip title={t('Several entries: edit them in Timesheets')}>
          <Typography align="center" sx={{ px: 1 }}>
            {formatHours(cell.total)}
          </Typography>
        </Tooltip>
      )
    }
    return (
      <TextField
        type="text"
        disabled={busy}
        value={valueFor(task.id, date)}
        onChange={(e) => setEdits((prev) => ({ ...prev, [`${task.id}|${date}`]: e.target.value }))}
        onBlur={(e) => void commitCell(task, date, e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
        slotProps={{ htmlInput: { role: 'spinbutton', 'aria-label': `${task.name} ${dayLabelOf(date)}` } }}
        sx={{ minWidth: 56 }}
      />
    )
  }

  // The page chrome (title, week range, navigation) stays mounted while the
  // week loads; only this block switches, so the heading node is stable.
  const grid =
    allRows === null ? null : (
    <>
      {error ? <Alert severity="error" sx={{ my: 2 }}>{error}</Alert> : null}
      {capped ? (
        <Typography variant="caption" color="text.secondary">
          {t('First 1000 shown')}
        </Typography>
      ) : null}
      {phone ? (
        <>
          <Tabs value={selectedDay} onChange={(_, v) => setSelectedDay(v)} variant="scrollable" scrollButtons="auto" sx={{ mt: 2 }}>
            {days.map((date, i) => (
              <Tab key={date} value={i} label={`${t(DAY_LABELS[i])} ${formatHours(colTotal(date))}`} />
            ))}
          </Tabs>
          <Stack spacing={2} sx={{ mt: 2 }}>
            {allRows.map((task) => {
              const cell = cellOf(task.id, days[selectedDay])
              return (
                <Card
                  key={task.id}
                  component="article"
                  aria-label={task.name}
                  variant="outlined"
                  style={{ width: '100%' }}
                  sx={{ p: 2 }}
                >
                  <Box sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
                    <Typography sx={{ flexGrow: 1 }}>{task.name}</Typography>
                    {cell.kind === 'multi' ? (
                      <Tooltip title={t('Several entries: edit them in Timesheets')}>
                        <Typography align="center">{formatHours(cell.total)}</Typography>
                      </Tooltip>
                    ) : (
                      <TextField
                        type="text"
                        disabled={busy}
                        value={valueFor(task.id, days[selectedDay])}
                        onChange={(e) => setEdits((prev) => ({ ...prev, [`${task.id}|${days[selectedDay]}`]: e.target.value }))}
                        onBlur={(e) => void commitCell(task, days[selectedDay], e.target.value)}
                        slotProps={{ htmlInput: { role: 'spinbutton', 'aria-label': `${task.name} ${dayLabelOf(days[selectedDay])}` } }}
                        style={{ width: 96 }}
                      />
                    )}
                  </Box>
                </Card>
              )
            })}
            <Typography align="right">
              {t('Total')}: {formatHours(colTotal(days[selectedDay]))}
            </Typography>
          </Stack>
        </>
      ) : (
        <TableContainer sx={{ mt: 2 }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t('Task')}</TableCell>
                {days.map((date, i) => (
                  <TableCell key={date} align="center">
                    {t(DAY_LABELS[i])}
                  </TableCell>
                ))}
                <TableCell align="right">{t('Total')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {allRows.map((task) => (
                <TableRow key={task.id} aria-label={task.name}>
                  <TableCell>{task.name}</TableCell>
                  {days.map((date) => (
                    <TableCell key={date} align="center" sx={{ py: 0.5 }}>
                      {cellFor(task, date)}
                    </TableCell>
                  ))}
                  <TableCell align="right">{formatHours(rowTotal(task.id))}</TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow aria-label={t('Totals')}>
                <TableCell>{t('Totals')}</TableCell>
                {days.map((date) => (
                  <TableCell key={date} align="center">
                    {formatHours(colTotal(date))}
                  </TableCell>
                ))}
                <TableCell align="right">{formatHours(grandTotal)}</TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </TableContainer>
      )}
    </>
  )

  return (
    <Box sx={{ p: { xs: 2, md: 4 } }}>
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 2, flexWrap: 'wrap' }}>
        <Typography variant="h4" component="h1">
          {t('Timesheet week')}
        </Typography>
        <Typography variant="subtitle1" color="text.secondary">
          {weekStart} – {addDaysIso(weekStart, 6)}
        </Typography>
      </Box>
      <Stack direction="row" spacing={1} sx={{ my: 2 }}>
        <Button size="small" variant="outlined" onClick={() => goWeek(-1)}>
          {t('Previous week')}
        </Button>
        <Button size="small" variant="outlined" onClick={() => goWeek(1)}>
          {t('Next week')}
        </Button>
        <Button size="small" variant="contained" onClick={() => setAdding(true)}>
          {t('Add task')}
        </Button>
      </Stack>
      {grid}

      <Dialog open={adding} onClose={() => setAdding(false)} fullWidth maxWidth="xs">
        <DialogTitle>{t('Add task')}</DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '8px !important' }}>
          <TextField
            label={t('Search tasks')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void searchTasks()
            }}
            autoFocus
          />
          {results === null ? null : results.length === 0 ? (
            <Typography>{t('No matching tasks')}</Typography>
          ) : (
            <List sx={{ maxHeight: 320, overflowY: 'auto' }}>
              {results.map((task) => (
                <ListItemButton key={task.id} onClick={() => addTask(task)}>
                  {task.name}
                </ListItemButton>
              ))}
            </List>
          )}
        </DialogContent>
      </Dialog>
    </Box>
  )
}
