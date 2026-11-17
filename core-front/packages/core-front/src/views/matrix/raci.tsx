'use client'
import { useEffect, useMemo, useState } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { useTheme } from '@mui/material/styles'
import { usePermission } from '../../auth/Can'
import { serializeError, toApiError, type SerializedError } from '../../api/errors'
import type { EntityListOptions } from '../../api/list-options'
import type { MatrixConfig } from '../../api/view-fields'
import { useT } from '../../i18n/translate'
import { ErrorAlert } from '../error-alert'
import { DiagramLoading } from '../diagram/diagram-canvas'
import { usePhone } from '../use-phone'
import { useRelationOps, type RelationRecord } from '../relation-ops'
import { dsmOrder } from './dsm'
import type { MatrixTask } from './matrix-renderer'

const PAGE_SIZE = 200
const USER_CHUNK = 100

export const RACI_ROLES = ['R', 'A', 'C', 'I'] as const
type RaciRole = (typeof RACI_ROLES)[number]

/** The tap cycle: none -> R -> A -> C -> I -> none. */
export function nextRole(current: unknown): RaciRole | null {
  if (typeof current !== 'string' || !(RACI_ROLES as readonly string[]).includes(current)) return 'R'
  const i = RACI_ROLES.indexOf(current as RaciRole)
  return i + 1 < RACI_ROLES.length ? RACI_ROLES[i + 1] : null
}

interface Person {
  id: string
  label: string
}
interface Cell {
  role: RaciRole
  rowId: string
}

export interface RaciProps {
  tasks: MatrixTask[]
  config: MatrixConfig
  projectId: string
}

/**
 * The RACI accountability matrix (ADR-041): rows are the tasks in WBS order,
 * columns are the project's manager plus its members (the `project_member`
 * rows, plus anyone already holding a RACI role). A cell is one
 * `project_task_raci` row (task x user x role R/A/C/I): with write permission
 * a tap cycles none -> R -> A -> C -> I -> none through create / update /
 * delete, optimistically, reverting on a rejection (a 422 `ONE_ACCOUNTABLE`
 * shows the server's message); a task without an `A` is flagged "No one
 * accountable". Read-only users see the letters only. On phone the grid
 * becomes a per-task card listing `R / A / C / I` and an `Edit` dialog with
 * one select per person.
 */
export function Raci({ tasks, config, projectId }: RaciProps) {
  const t = useT()
  const th = useTheme()
  const ops = useRelationOps()
  const phone = usePhone()
  const canWrite = usePermission(`${config.raciEntity}:${config.raciEntity}:write`)
  const [people, setPeople] = useState<Person[] | null>(null)
  const [cells, setCells] = useState<Record<string, Cell>>({})
  const [error, setError] = useState<SerializedError | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<Record<string, RaciRole | ''>>({})

  const listPage = ops?.listPage
  const get = ops?.get
  const { raciEntity, projectField, userLabelField } = config
  useEffect(() => {
    if (!listPage) return
    let cancelled = false
    const paged = async (entity: string, options: EntityListOptions) => {
      const out: RelationRecord[] = []
      for (let page = 1; ; page++) {
        const res = await listPage(entity, { ...options, pageSize: PAGE_SIZE, page })
        out.push(...res.records)
        if (res.records.length < PAGE_SIZE) break
      }
      return out
    }
    const load = async () => {
      const proj = (await get?.('project', projectId).catch(() => null)) as RelationRecord | null
      const manager = typeof proj?.manager_id === 'string' ? proj.manager_id : ''
      const members = (await paged('project_member', { filter: { [projectField]: projectId }, order: 'created_at' }))
        .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')))
        .map((r) => String(r.user_id ?? ''))
      const rows = await paged(raciEntity, { filter: { [projectField]: projectId }, order: 'created_at' })
      // Manager first, then the members, then anyone already holding a role.
      const ids = [...new Set([manager, ...members, ...rows.map((r) => String(r.user_id ?? ''))].filter(Boolean))]
      const users: RelationRecord[] = []
      for (let i = 0; i < ids.length; i += USER_CHUNK) users.push(...(await paged('users', { in: { id: ids.slice(i, i + USER_CHUNK) } })))
      const labelOf = new Map(users.map((u) => [u.id, String(u[userLabelField] ?? u.id)]))
      const cols = ids.map((id) => ({ id, label: labelOf.get(id) ?? id }))
      const map: Record<string, Cell> = {}
      for (const r of rows) map[`${r.task_id}:${r.user_id}`] = { role: String(r.role) as RaciRole, rowId: r.id }
      return { cols, map }
    }
    load().then(
      (r) => {
        if (cancelled) return
        setPeople(r.cols)
        setCells(r.map)
      },
      (e: unknown) => {
        if (cancelled) return
        setPeople([])
        setCells({})
        setError(serializeError(toApiError(e)))
      },
    )
    return () => {
      cancelled = true
    }
  }, [listPage, get, raciEntity, projectField, userLabelField, projectId])

  const rows = useMemo(() => dsmOrder(tasks), [tasks])
  const cellOf = (taskId: string, userId: string) => cells[`${taskId}:${userId}`]
  const hasAccountable = (taskId: string) => people?.some((p) => cellOf(taskId, p.id)?.role === 'A') ?? false

  // Apply a role change optimistically; `value` of undefined clears the cell.
  const apply = (taskId: string, userId: string, value: Cell | undefined) =>
    setCells((cs) => {
      const out = { ...cs }
      const key = `${taskId}:${userId}`
      if (value) out[key] = value
      else delete out[key]
      return out
    })

  async function cycle(taskId: string, userId: string) {
    if (!ops) return
    const current = cellOf(taskId, userId)
    const next = nextRole(current?.role)
    setError(null)
    if (next) apply(taskId, userId, { role: next, rowId: current?.rowId ?? '' })
    else apply(taskId, userId, undefined)
    try {
      if (next === null) {
        if (current) await ops.remove(raciEntity, current.rowId)
      } else if (!current) {
        const row = await ops.create(raciEntity, { task_id: taskId, user_id: userId, role: next })
        apply(taskId, userId, { role: next, rowId: row.id })
      } else {
        await ops.update?.(raciEntity, current.rowId, { role: next })
      }
    } catch (e) {
      apply(taskId, userId, current)
      setError(serializeError(toApiError(e)))
    }
  }

  function openDialog(taskId: string) {
    setDraft(Object.fromEntries((people ?? []).map((p) => [p.id, cellOf(taskId, p.id)?.role ?? ''])))
    setEditing(taskId)
  }

  async function commitDialog(taskId: string) {
    if (!ops) return
    for (const p of people ?? []) {
      const next = (draft[p.id] ?? '') as RaciRole | ''
      const current = cellOf(taskId, p.id)
      if (next === (current?.role ?? '')) continue
      apply(taskId, p.id, next ? { role: next, rowId: current?.rowId ?? '' } : undefined)
      try {
        if (!next) {
          if (current) await ops.remove(raciEntity, current.rowId)
        } else if (!current) {
          const row = await ops.create(raciEntity, { task_id: taskId, user_id: p.id, role: next })
          apply(taskId, p.id, { role: next, rowId: row.id })
        } else {
          await ops.update?.(raciEntity, current.rowId, { role: next })
        }
      } catch (e) {
        apply(taskId, p.id, current)
        setError(serializeError(toApiError(e)))
        return
      }
    }
    setEditing(null)
  }

  if (!people) return <DiagramLoading />
  const editingTask = editing ? rows.find((task) => task.id === editing) : null
  const headerStyle = { border: `1px solid ${th.palette.divider}`, padding: th.spacing(0.5, 1), whiteSpace: 'nowrap' } as const

  return (
    <Box sx={{ pt: 0.5 }}>
      <ErrorAlert error={error} />
      {phone ? (
        <Box data-testid="raci-cards">
          {rows.map((task) => (
            <Box key={task.id} data-testid={`raci-card-${task.id}`} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1, mb: 1, bgcolor: 'background.paper' }}>
              <Typography variant="body2" noWrap>
                {task.name}
              </Typography>
              {!hasAccountable(task.id) ? (
                <Typography variant="caption" color="warning.main" sx={{ display: 'block' }}>
                  {t('No one accountable')}
                </Typography>
              ) : null}
              {RACI_ROLES.map((role) => (
                <Typography key={role} variant="body2">
                  {`${role}: ${
                    people.filter((p) => cellOf(task.id, p.id)?.role === role).map((p) => p.label).join(', ') || '–'
                  }`}
                </Typography>
              ))}
              {canWrite ? (
                <Button size="small" variant="outlined" onClick={() => openDialog(task.id)} sx={{ mt: 0.5, minHeight: 40 }}>
                  {t('Edit')}
                </Button>
              ) : null}
            </Box>
          ))}
        </Box>
      ) : (
        <Box data-testid="raci-grid" sx={{ overflow: 'auto', maxHeight: 'calc(100dvh - 240px)', border: 1, borderColor: 'divider', borderRadius: 1 }}>
          <table style={{ borderCollapse: 'collapse', width: 'max-content' }}>
            <thead data-testid="raci-header">
              <tr>
                <th style={{ ...headerStyle, textAlign: 'left' }} aria-label="corner" />
                {people.map((p) => (
                  <th key={p.id} data-testid={`raci-col-${p.id}`} style={{ ...headerStyle, minWidth: 96 }}>
                    {p.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((task) => (
                <tr key={task.id}>
                  <th data-testid={`raci-row-${task.id}`} style={{ ...headerStyle, textAlign: 'left', maxWidth: 240 }}>
                    {task.name}
                    {!hasAccountable(task.id) ? (
                      <Typography variant="caption" color="warning.main" sx={{ display: 'block' }}>
                        {t('No one accountable')}
                      </Typography>
                    ) : null}
                  </th>
                  {people.map((p) => {
                    const value = cellOf(task.id, p.id)
                    return (
                      <td key={p.id} style={{ width: 44, height: 44, border: `1px solid ${th.palette.divider}` }}>
                        {canWrite ? (
                          <Button
                            data-testid={`raci-cell-${task.id}-${p.id}`}
                            size="small"
                            onClick={() => cycle(task.id, p.id)}
                            sx={{ width: '100%', height: '100%', minWidth: 32, minHeight: 32, p: 0, fontWeight: 'medium' }}
                          >
                            {value?.role ?? ''}
                          </Button>
                        ) : (
                          <span data-testid={`raci-cell-${task.id}-${p.id}`}>{value?.role ?? ''}</span>
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </Box>
      )}
      {editingTask ? (
        <Dialog open onClose={() => setEditing(null)} fullWidth maxWidth="xs">
          <Box sx={{ p: 2 }}>
            <Typography variant="subtitle1" sx={{ mb: 1 }}>
              {editingTask.name}
            </Typography>
            {people.map((p) => (
              <Select
                key={p.id}
                label={p.label}
                size="small"
                value={draft[p.id] ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, [p.id]: e.target.value as RaciRole | '' }))}
                sx={{ mb: 1, minHeight: phone ? 48 : 40 }}
              >
                <MenuItem value="">–</MenuItem>
                {RACI_ROLES.map((role) => (
                  <MenuItem key={role} value={role}>
                    {role}
                  </MenuItem>
                ))}
              </Select>
            ))}
            <Stack direction="row" spacing={1} sx={{ mt: 1, justifyContent: 'flex-end' }}>
              <Button onClick={() => setEditing(null)}>{t('Cancel')}</Button>
              <Button variant="contained" onClick={() => commitDialog(editingTask.id)}>
                {t('Save')}
              </Button>
            </Stack>
          </Box>
        </Dialog>
      ) : null}
    </Box>
  )
}
