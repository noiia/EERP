'use client'
import { useEffect, useMemo, useState } from 'react'
import Box from '@mui/material/Box'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import Dialog from '@mui/material/Dialog'
import ListItemText from '@mui/material/ListItemText'
import Menu from '@mui/material/Menu'
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

interface Person {
  id: string
  label: string
}
/** One task x user cell: role -> its row id ('' while the create is in flight). */
type Roles = Partial<Record<RaciRole, string>>

export interface RaciProps {
  tasks: MatrixTask[]
  config: MatrixConfig
  projectId: string
}

/** The roles a cell holds, in R/A/C/I order. */
const lettersOf = (r: Roles): RaciRole[] => RACI_ROLES.filter((role) => role in r)
const wrap = { whiteSpace: 'normal', overflowWrap: 'anywhere', wordBreak: 'break-word' } as const

/**
 * The RACI accountability matrix (ADR-041): rows are the tasks in WBS order,
 * columns are the project's manager plus its members (the `project_member`
 * rows, plus anyone already holding a RACI role). A cell is the set of
 * `project_task_raci` rows of one task x user (one row per role, so a user
 * may be both A and R). With write permission a click opens a menu of the
 * four roles to tick, saved at once through create / delete (optimistic,
 * reverted on a rejection). A task with several accountables is listed in a
 * warning on top, one without an `A` is flagged "No one accountable". Bulk
 * edit ticks several rows and sets one person's roles on all of them.
 * Read-only users see the letters only. On phone the grid becomes a per-task
 * card listing `R / A / C / I` and an `Edit` dialog with one select per person.
 */
export function Raci({ tasks, config, projectId }: RaciProps) {
  const t = useT()
  const th = useTheme()
  const ops = useRelationOps()
  const phone = usePhone()
  const canWrite = usePermission(`${config.raciEntity}:${config.raciEntity}:write`)
  const [people, setPeople] = useState<Person[] | null>(null)
  const [cells, setCells] = useState<Record<string, Roles>>({})
  const [error, setError] = useState<SerializedError | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<Record<string, RaciRole[]>>({})
  const [menu, setMenu] = useState<{ anchor: HTMLElement; taskId: string; userId: string } | null>(null)
  const [bulk, setBulk] = useState(false)
  const [picked, setPicked] = useState<string[]>([])
  const [bulkUser, setBulkUser] = useState('')
  const [bulkRoles, setBulkRoles] = useState<RaciRole[]>([])

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
      const map: Record<string, Roles> = {}
      for (const r of rows) {
        const key = `${r.task_id}:${r.user_id}`
        map[key] = { ...map[key], [String(r.role)]: r.id }
      }
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
  const rolesOf = (taskId: string, userId: string): Roles => cells[`${taskId}:${userId}`] ?? {}
  const accountables = (taskId: string) => people?.filter((p) => 'A' in rolesOf(taskId, p.id)).length ?? 0
  const put = (key: string, value: Roles) => setCells((cs) => ({ ...cs, [key]: value }))

  // Make one cell hold exactly `next`: delete the dropped roles' rows, create
  // the added ones. Optimistic; on a failure the cell keeps what did commit.
  async function setRoles(taskId: string, userId: string, next: RaciRole[]): Promise<boolean> {
    if (!ops) return false
    const key = `${taskId}:${userId}`
    const current = rolesOf(taskId, userId)
    const done: Roles = { ...current }
    setError(null)
    put(key, Object.fromEntries(next.map((role) => [role, current[role] ?? ''])))
    try {
      for (const role of RACI_ROLES) {
        const id = current[role]
        if (id !== undefined && !next.includes(role)) {
          if (id) await ops.remove(raciEntity, id)
          delete done[role]
        } else if (id === undefined && next.includes(role)) {
          done[role] = (await ops.create(raciEntity, { task_id: taskId, user_id: userId, role })).id
        }
      }
      put(key, done)
      return true
    } catch (e) {
      put(key, done)
      setError(serializeError(toApiError(e)))
      return false
    }
  }

  function toggle(taskId: string, userId: string, role: RaciRole) {
    const have = lettersOf(rolesOf(taskId, userId))
    void setRoles(taskId, userId, have.includes(role) ? have.filter((r) => r !== role) : [...have, role])
  }

  async function applyBulk() {
    for (const taskId of picked) if (!(await setRoles(taskId, bulkUser, bulkRoles))) return
    setPicked([])
  }

  function openDialog(taskId: string) {
    setDraft(Object.fromEntries((people ?? []).map((p) => [p.id, lettersOf(rolesOf(taskId, p.id))])))
    setEditing(taskId)
  }

  async function commitDialog(taskId: string) {
    for (const p of people ?? []) {
      const next = draft[p.id] ?? []
      if (next.join() === lettersOf(rolesOf(taskId, p.id)).join()) continue
      if (!(await setRoles(taskId, p.id, next))) return
    }
    setEditing(null)
  }

  const pick = (taskId: string, on: boolean) => setPicked((ps) => (on ? [...ps, taskId] : ps.filter((id) => id !== taskId)))
  const rowCheckbox = (taskId: string, name: string) =>
    bulk ? (
      <Checkbox
        size="small"
        checked={picked.includes(taskId)}
        onChange={(e) => pick(taskId, e.target.checked)}
        slotProps={{ input: { 'aria-label': name } }}
        sx={{ p: 0.5 }}
      />
    ) : null
  const rolesSelect = (value: RaciRole[], onChange: (v: RaciRole[]) => void, label: string, testId?: string) => (
    <Select
      multiple
      displayEmpty
      size="small"
      value={value}
      onChange={(e) => onChange(RACI_ROLES.filter((r) => (e.target.value as string[]).includes(r)))}
      renderValue={(v) => (v.length ? v.join(', ') : '–')}
      inputProps={{ 'aria-label': label, 'data-testid': testId }}
      sx={{ minWidth: 96, minHeight: phone ? 48 : 40 }}
    >
      {RACI_ROLES.map((role) => (
        <MenuItem key={role} value={role}>
          <Checkbox size="small" checked={value.includes(role)} sx={{ p: 0.5, mr: 1 }} />
          <ListItemText primary={role} />
        </MenuItem>
      ))}
    </Select>
  )

  if (!people) return <DiagramLoading />
  const editingTask = editing ? rows.find((task) => task.id === editing) : null
  const multiA = rows.filter((task) => accountables(task.id) > 1)
  const headerStyle = { border: `1px solid ${th.palette.divider}`, padding: th.spacing(0.5, 1), ...wrap } as const
  const menuRoles = menu ? lettersOf(rolesOf(menu.taskId, menu.userId)) : []

  return (
    <Box sx={{ pt: 0.5 }}>
      <ErrorAlert error={error} />
      {multiA.length ? (
        <Alert severity="warning" data-testid="raci-multi-accountable" sx={{ mb: 1 }}>
          {`${t('Several people accountable')}: ${multiA.map((task) => task.name).join(', ')}`}
        </Alert>
      ) : null}
      {canWrite ? (
        <Stack direction="row" spacing={1} useFlexGap sx={{ mb: 1, flexWrap: 'wrap', alignItems: 'center' }}>
          <Button
            size="small"
            variant={bulk ? 'contained' : 'outlined'}
            onClick={() => {
              setBulk((b) => !b)
              setPicked([])
            }}
            sx={{ minHeight: phone ? 40 : undefined }}
          >
            {t('Bulk edit')}
          </Button>
          {bulk ? (
            <>
              <Checkbox
                size="small"
                checked={picked.length === rows.length && rows.length > 0}
                indeterminate={picked.length > 0 && picked.length < rows.length}
                onChange={(e) => setPicked(e.target.checked ? rows.map((task) => task.id) : [])}
                slotProps={{ input: { 'aria-label': t('Select all') } }}
              />
              <Select
                displayEmpty
                size="small"
                value={bulkUser}
                onChange={(e) => setBulkUser(e.target.value)}
                inputProps={{ 'aria-label': t('Person'), 'data-testid': 'raci-bulk-user' }}
                sx={{ minWidth: 160, minHeight: phone ? 48 : 40 }}
              >
                <MenuItem value="">{t('Person')}</MenuItem>
                {people.map((p) => (
                  <MenuItem key={p.id} value={p.id}>
                    {p.label}
                  </MenuItem>
                ))}
              </Select>
              {rolesSelect(bulkRoles, setBulkRoles, t('Roles'), 'raci-bulk-roles')}
              <Button size="small" variant="contained" disabled={!bulkUser || picked.length === 0} onClick={() => void applyBulk()}>
                {`${t('Apply')} (${picked.length})`}
              </Button>
            </>
          ) : null}
        </Stack>
      ) : null}
      {phone ? (
        <Box data-testid="raci-cards">
          {rows.map((task) => (
            <Box key={task.id} data-testid={`raci-card-${task.id}`} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1, mb: 1, bgcolor: 'background.paper' }}>
              <Stack direction="row" sx={{ alignItems: 'flex-start' }}>
                {rowCheckbox(task.id, task.name)}
                <Typography variant="body2" sx={wrap}>
                  {task.name}
                </Typography>
              </Stack>
              {!accountables(task.id) ? (
                <Typography variant="caption" color="warning.main" sx={{ display: 'block' }}>
                  {t('No one accountable')}
                </Typography>
              ) : null}
              {RACI_ROLES.map((role) => (
                <Typography key={role} variant="body2" sx={wrap}>
                  {`${role}: ${people.filter((p) => role in rolesOf(task.id, p.id)).map((p) => p.label).join(', ') || '–'}`}
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
                  <th key={p.id} data-testid={`raci-col-${p.id}`} style={{ ...headerStyle, minWidth: 96, maxWidth: 160 }}>
                    {p.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((task) => (
                <tr key={task.id}>
                  <th data-testid={`raci-row-${task.id}`} style={{ ...headerStyle, textAlign: 'left', minWidth: 160, maxWidth: 280, fontWeight: 'normal' }}>
                    <Stack direction="row" sx={{ alignItems: 'flex-start' }}>
                      {rowCheckbox(task.id, task.name)}
                      <Box>
                        {task.name}
                        {!accountables(task.id) ? (
                          <Typography variant="caption" color="warning.main" sx={{ display: 'block' }}>
                            {t('No one accountable')}
                          </Typography>
                        ) : null}
                      </Box>
                    </Stack>
                  </th>
                  {people.map((p) => {
                    const letters = lettersOf(rolesOf(task.id, p.id)).join('/')
                    return (
                      <td key={p.id} style={{ width: 44, height: 44, border: `1px solid ${th.palette.divider}` }}>
                        {canWrite ? (
                          <Button
                            data-testid={`raci-cell-${task.id}-${p.id}`}
                            size="small"
                            aria-haspopup="menu"
                            aria-label={`${task.name} – ${p.label}`}
                            onClick={(e) => setMenu({ anchor: e.currentTarget, taskId: task.id, userId: p.id })}
                            sx={{ width: '100%', height: '100%', minWidth: 32, minHeight: 32, p: 0, fontWeight: 'medium' }}
                          >
                            {letters}
                          </Button>
                        ) : (
                          <span data-testid={`raci-cell-${task.id}-${p.id}`}>{letters}</span>
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
      <Menu anchorEl={menu?.anchor ?? null} open={Boolean(menu)} onClose={() => setMenu(null)} data-testid="raci-menu">
        {RACI_ROLES.map((role) => (
          <MenuItem key={role} onClick={() => menu && toggle(menu.taskId, menu.userId, role)}>
            <Checkbox size="small" checked={menuRoles.includes(role)} sx={{ p: 0.5, mr: 1 }} />
            <ListItemText primary={role} />
          </MenuItem>
        ))}
      </Menu>
      {editingTask ? (
        <Dialog open onClose={() => setEditing(null)} fullWidth maxWidth="xs">
          <Box sx={{ p: 2 }}>
            <Typography variant="subtitle1" sx={{ mb: 1, ...wrap }}>
              {editingTask.name}
            </Typography>
            {people.map((p) => (
              <Stack key={p.id} direction="row" spacing={1} sx={{ mb: 1, alignItems: 'center', justifyContent: 'space-between' }}>
                <Typography variant="body2" sx={wrap}>
                  {p.label}
                </Typography>
                {rolesSelect(draft[p.id] ?? [], (v) => setDraft((d) => ({ ...d, [p.id]: v })), p.label)}
              </Stack>
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
