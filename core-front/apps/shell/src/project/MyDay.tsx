'use client'

import { useEffect, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Card,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material'
import { unwrapActionResult, usePhone, useT, type EntityListOptions } from '@eerp/core-front'
import { createRelationRecord, getRecord, listRecords, updateRelationRecord } from '@/lib/relation-actions'

/** One open (not closed) task assigned to me, as the list endpoint returns it. */
type Task = { id: string; name: string; project_id: string; deadline: string | null; spent_hours: number }
/** One project stage (only `id` matters here: the closed stage a Done action moves the task to). */
type Stage = { id: string; name: string }

const PAGE_SIZE = 200
/** Hard read cap: loops page until a short page, and stops at 1000. */
const READ_CAP = 1000

const GROUPS = ['Overdue', 'Today', 'This week', 'Later', 'No deadline'] as const
type Group = (typeof GROUPS)[number]

function toIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function todayIso(): string {
  return toIso(new Date())
}
function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  return toIso(new Date(y, m - 1, d + days))
}
/** Group a deadline into the five My day buckets (null is its own bucket). */
function groupOf(deadline: string | null, today: string): Group {
  if (!deadline) return 'No deadline'
  if (deadline < today) return 'Overdue'
  if (deadline === today) return 'Today'
  if (deadline <= addDaysIso(today, 7)) return 'This week'
  return 'Later'
}
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
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

export function MyDay() {
  const t = useT()
  const phone = usePhone()
  const [tasks, setTasks] = useState<Task[] | null>(null)
  const [capped, setCapped] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  // project_id -> id of the project's first (lowest sequence) closed stage: the Done target.
  const [doneStage, setDoneStage] = useState<Record<string, string>>({})
  const [logging, setLogging] = useState<Task | null>(null)
  const [hoursValue, setHoursValue] = useState('1')
  const [logDate, setLogDate] = useState('')
  const [dialogError, setDialogError] = useState('')
  const today = todayIso()

  async function load() {
    setError('')
    try {
      const { records, capped: isCapped } = await pageAll<Task>('project_task', {
        filter: { assignee: 'me', closed: 'false' },
        order: 'deadline',
      })
      setTasks(records)
      setCapped(isCapped)
      // Done actions need the per-project closed stage (each project's first one).
      const byProject: Record<string, string> = {}
      for (const pid of new Set(records.map((r) => r.project_id))) {
        const stages = await pageAll<Stage>('project_stage', {
          filter: { project_id: pid, closed: 'true' },
          order: 'sequence',
        })
        const first = stages.records[0]
        if (first) byProject[pid] = first.id
      }
      setDoneStage(byProject)
    } catch (e) {
      setTasks([])
      setError(errorMessage(e))
    }
  }

  useEffect(() => {
    void load()
  }, [])

  function openLog(task: Task) {
    setLogging(task)
    setHoursValue('1')
    setLogDate(today)
    setDialogError('')
  }

  async function submitLog() {
    if (!logging) return
    const hours = Number(hoursValue)
    if (!Number.isFinite(hours) || hours <= 0 || !logDate) return
    setBusy(true)
    setDialogError('')
    try {
      // user_id is filled by the server (my line); the hours>0 guard is enforced there too.
      unwrapActionResult(
        await createRelationRecord('project_timesheet', {
          task_id: logging.id,
          hours,
          date: logDate,
        }),
      )
      const fresh = unwrapActionResult(await getRecord('project_task', logging.id)) as Task
      setTasks((ts) =>
        (ts ?? []).map((x) => (x.id === logging.id ? { ...x, spent_hours: Number(fresh.spent_hours ?? 0) } : x)),
      )
      setLogging(null)
    } catch (e) {
      setDialogError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  async function markDone(task: Task) {
    const stageId = doneStage[task.project_id]
    if (!stageId) return
    setBusy(true)
    setError('')
    try {
      unwrapActionResult(await updateRelationRecord('project_task', task.id, { stage_id: stageId }))
      setTasks((ts) => (ts ?? []).filter((x) => x.id !== task.id))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  if (tasks === null) {
    return (
      <Box sx={{ p: 4 }}>
        <Typography variant="h4" component="h1">
          {t('My day')}
        </Typography>
      </Box>
    )
  }

  const rowsByGroup = (group: Group) => (tasks ?? []).filter((task) => groupOf(task.deadline, today) === group)
  const empty = tasks.length === 0

  function actions(task: Task) {
    const stageId = doneStage[task.project_id]
    return (
      <Stack direction={phone ? 'column' : 'row'} spacing={1}>
        <Button variant="outlined" disabled={busy} onClick={() => openLog(task)} style={phone ? { minHeight: 40 } : undefined}>
          {t('Log time')}
        </Button>
        {stageId ? (
          <Button variant="contained" disabled={busy} onClick={() => void markDone(task)} style={phone ? { minHeight: 40 } : undefined}>
            {t('Done')}
          </Button>
        ) : null}
      </Stack>
    )
  }

  return (
    <Box sx={{ p: { xs: 2, md: 4 } }}>
      <Typography variant="h4" component="h1">
        {t('My day')}
      </Typography>
      {error ? <Alert severity="error" sx={{ my: 2 }}>{error}</Alert> : null}
      {capped ? (
        <Typography variant="caption" color="text.secondary">
          {t('First 1000 shown')}
        </Typography>
      ) : null}

      {empty ? (
        <Typography sx={{ mt: 4 }}>{t('No open tasks')}</Typography>
      ) : (
        GROUPS.map((group) => {
          const rows = rowsByGroup(group)
          if (rows.length === 0) return null
          return (
            <Box key={group} component="section" aria-label={t(group)} sx={{ mt: 3 }}>
              <Typography variant="h6">{t(group)}</Typography>
              {phone ? (
                <Stack spacing={2} sx={{ mt: 1 }}>
                  {rows.map((task) => (
                    <Card
                      key={task.id}
                      component="article"
                      aria-label={task.name}
                      variant="outlined"
                      style={{ width: '100%' }}
                      sx={{ p: 2 }}
                    >
                      <Stack spacing={1}>
                        <Stack direction="row" spacing={1} sx={{ justifyContent: 'space-between' }}>
                          <Typography variant="subtitle1">{task.name}</Typography>
                          <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
                            {task.deadline ?? '—'}
                          </Typography>
                        </Stack>
                        <Typography variant="body2" color="text.secondary">
                          {t('Spent hours')}: {task.spent_hours}
                        </Typography>
                        {actions(task)}
                      </Stack>
                    </Card>
                  ))}
                </Stack>
              ) : (
                <TableContainer sx={{ mt: 1 }}>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>{t('Task')}</TableCell>
                        <TableCell>{t('Deadline')}</TableCell>
                        <TableCell align="right">{t('Spent hours')}</TableCell>
                        <TableCell align="right">{t('Actions')}</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {rows.map((task) => (
                        <TableRow key={task.id} aria-label={task.name}>
                          <TableCell>{task.name}</TableCell>
                          <TableCell>{task.deadline ?? '—'}</TableCell>
                          <TableCell align="right">{task.spent_hours}</TableCell>
                          <TableCell align="right">{actions(task)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              )}
            </Box>
          )
        })
      )}

      <Dialog open={logging !== null} onClose={() => setLogging(null)} fullWidth maxWidth="xs">
        <DialogTitle>{t('Log time')}</DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '8px !important' }}>
          {dialogError ? <Alert severity="error">{dialogError}</Alert> : null}
          {/* Typeable number input with spinbutton semantics: the value stays a string so a
              refused or in-flight edit can be restored verbatim. */}
          <TextField
            label={t('Hours')}
            type="text"
            value={hoursValue}
            onChange={(e) => setHoursValue(e.target.value)}
            slotProps={{ htmlInput: { role: 'spinbutton' } }}
            autoFocus
          />
          <TextField label={t('Date')} type="date" value={logDate} onChange={(e) => setLogDate(e.target.value)} />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setLogging(null)} disabled={busy}>
            {t('Cancel')}
          </Button>
          <Button variant="contained" onClick={() => void submitLog()} disabled={busy || !(Number(hoursValue) > 0) || !logDate}>
            {t('Log')}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
