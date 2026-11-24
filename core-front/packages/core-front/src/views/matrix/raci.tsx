'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import Box from '@mui/material/Box'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import Radio from '@mui/material/Radio'
import Dialog from '@mui/material/Dialog'
import IconButton from '@mui/material/IconButton'
import ListItemText from '@mui/material/ListItemText'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import Stack from '@mui/material/Stack'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import { useTheme } from '@mui/material/styles'
import { usePermission } from '../../auth/Can'
import { serializeError, toApiError, type SerializedError } from '../../api/errors'
import type { EntityListOptions } from '../../api/list-options'
import type { MatrixConfig } from '../../api/view-fields'
import { useT } from '../../i18n/translate'
import { ErrorAlert } from '../error-alert'
import { byPrefixAndName, FontAwesomeIcon } from '../icons'
import { DiagramLoading } from '../diagram/diagram-canvas'
import { ExportMenu } from '../diagram/toolbar'
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
/** Header text capped at 40 characters (the full text stays in the title). */
const clip = (s: string) => (s.length > 40 ? `${s.slice(0, 39)}…` : s)
const wrap = { whiteSpace: 'normal', overflowWrap: 'anywhere', wordBreak: 'break-word' } as const

/** The task tree read from `parentField` (a parent outside the loaded tasks makes a root). */
export function raciTree(tasks: MatrixTask[], parentField?: string) {
  const ids = new Set(tasks.map((task) => task.id))
  const parentOf = new Map<string, string>()
  const kidsOf = new Map<string, string[]>()
  for (const task of tasks) {
    const parent = parentField ? task[parentField] : null
    if (typeof parent !== 'string' || !ids.has(parent) || parent === task.id) continue
    parentOf.set(task.id, parent)
    kidsOf.set(parent, [...(kidsOf.get(parent) ?? []), task.id])
  }
  // Ancestors nearest first, cycle-safe.
  const ancestors = (id: string) => {
    const out: string[] = []
    for (let p = parentOf.get(id); p && !out.includes(p) && p !== id; p = parentOf.get(p)) out.push(p)
    return out
  }
  return { parentOf, kidsOf, ancestors }
}

/** A cell as shown: its own roles when it has any, else (a parent task) the union of its
 * subtasks' shown roles for that person — `computed` then. Leaves never compute. */
export interface Effective {
  roles: RaciRole[]
  computed: boolean
}
export function effectiveRoles(
  taskId: string,
  userId: string,
  stored: (taskId: string, userId: string) => RaciRole[],
  kidsOf: Map<string, string[]>,
  cache = new Map<string, Effective>(),
  seen = new Set<string>(),
): Effective {
  const key = `${taskId}:${userId}`
  const hit = cache.get(key)
  if (hit) return hit
  const own = stored(taskId, userId)
  let out: Effective = { roles: own, computed: false }
  const kids = kidsOf.get(taskId) ?? []
  if (!own.length && kids.length && !seen.has(taskId)) {
    seen.add(taskId)
    const union = new Set(kids.flatMap((k) => effectiveRoles(k, userId, stored, kidsOf, cache, seen).roles))
    seen.delete(taskId)
    out = { roles: RACI_ROLES.filter((r) => union.has(r)), computed: union.size > 0 }
  }
  cache.set(key, out)
  return out
}

/**
 * The RACI accountability matrix (ADR-041): rows are the tasks in WBS order,
 * columns are the project's manager plus its members (the `project_member`
 * rows, plus anyone already holding a RACI role). A cell holds the
 * `project_task_raci` row of one task x user (one explicit role per person).
 * With write permission a click opens a menu of the
 * four roles to choose, saved at once through update or create / delete (optimistic,
 * reverted on a rejection). A task with several accountables is listed in a
 * warning on top, one without an `A` is flagged "No one accountable". Bulk
 * edit ticks several rows and sets one person's role on all of them.
 * Read-only users see the letters only. On phone the grid becomes a per-task
 * card listing `R / A / C / I` and an `Edit` dialog with one select per person.
 */
export function Raci({ tasks, config, projectId }: RaciProps) {
  const pendingCells = useRef(new Set<string>())
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
  const [root, setRoot] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [projectName, setProjectName] = useState('')
  // Width of the task column while exporting: full titles wrap inside it instead of widening it.
  const [exportWidth, setExportWidth] = useState<number | null>(null)
  const table = useRef<HTMLTableElement>(null)

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
      const labelOf = new Map(users.map((u) => [u.id, String(u[userLabelField] || String(u.email ?? '').split('@')[0] || u.id)]))
      const cols = ids.map((id) => ({ id, label: labelOf.get(id) ?? id }))
      const map: Record<string, Roles> = {}
      for (const r of rows) {
        const key = `${r.task_id}:${r.user_id}`
        map[key] = { ...map[key], [String(r.role)]: r.id }
      }
      return { cols, map, name: String(proj?.name ?? '') }
    }
    load().then(
      (r) => {
        if (cancelled) return
        setPeople(r.cols)
        setCells(r.map)
        setProjectName(r.name)
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

  const ordered = useMemo(() => dsmOrder(tasks), [tasks])
  const tree = useMemo(() => raciTree(tasks, config.parentField), [tasks, config.parentField])
  const parents = ordered.filter((task) => tree.kidsOf.has(task.id))
  // The rows shown: the picked parent's subtree (all without one), minus collapsed branches.
  const rows = ordered.filter((task) => {
    const up = tree.ancestors(task.id)
    if (!root) return !up.some((a) => collapsed.has(a))
    if (task.id === root) return true
    const k = up.indexOf(root)
    return k >= 0 && !up.slice(0, k + 1).some((a) => collapsed.has(a))
  })
  const depthOf = (id: string) => {
    const up = tree.ancestors(id)
    return root ? Math.max(0, up.indexOf(root) + 1) : up.length
  }
  const rolesOf = (taskId: string, userId: string): Roles => cells[`${taskId}:${userId}`] ?? {}
  const cache = new Map<string, Effective>()
  const shown = (taskId: string, userId: string) => effectiveRoles(taskId, userId, (tid, uid) => lettersOf(rolesOf(tid, uid)), tree.kidsOf, cache)
  const accountables = (taskId: string, manualOnly = false) =>
    people?.filter((p) => {
      const e = shown(taskId, p.id)
      return e.roles.includes('A') && !(manualOnly && e.computed)
    }).length ?? 0
  const put = (key: string, value: Roles) => setCells((cs) => ({ ...cs, [key]: value }))

  // Change an existing role atomically when update is available. Otherwise,
  // remove before creating. On failure the cell keeps only what committed.
  async function setRoles(taskId: string, userId: string, next: RaciRole[]): Promise<boolean> {
    if (!ops || next.length > 1) return false
    const key = `${taskId}:${userId}`
    if (pendingCells.current.has(key)) return false
    pendingCells.current.add(key)
    const current = rolesOf(taskId, userId)
    const done: Roles = { ...current }
    setError(null)
    put(key, Object.fromEntries(next.map((role) => [role, current[role] ?? ''])))
    try {
      const existing = lettersOf(current)
      if (existing.length === 1 && next.length === 1 && existing[0] !== next[0] && ops.update) {
        const row = await ops.update(raciEntity, current[existing[0]]!, { role: next[0] })
        delete done[existing[0]]
        done[next[0]] = row.id
      } else {
        // Remove before creating, regardless of R/A/C/I sort order.
        for (const role of existing) {
          if (next.includes(role)) continue
          if (current[role]) await ops.remove(raciEntity, current[role]!)
          delete done[role]
        }
        for (const role of next) {
          if (done[role] === undefined) done[role] = (await ops.create(raciEntity, { task_id: taskId, user_id: userId, role })).id
        }
      }
      put(key, done)
      return true
    } catch (e) {
      put(key, done)
      setError(serializeError(toApiError(e)))
      return false
    } finally {
      pendingCells.current.delete(key)
    }
  }

  // Ticking a computed cell writes its roles by hand from then on; "Use computed values" goes back.
  function toggle(taskId: string, userId: string, role: RaciRole) {
    const have = shown(taskId, userId).roles
    void setRoles(taskId, userId, have.length === 1 && have[0] === role ? [] : [role])
  }

  async function applyBulk() {
    for (const taskId of picked) if (!(await setRoles(taskId, bulkUser, bulkRoles))) return
    setPicked([])
  }

  function openDialog(taskId: string) {
    setDraft(Object.fromEntries((people ?? []).map((p) => [p.id, shown(taskId, p.id).roles])))
    setEditing(taskId)
  }

  async function commitDialog(taskId: string) {
    for (const p of people ?? []) {
      const next = draft[p.id] ?? []
      if (next.join() === shown(taskId, p.id).roles.join()) continue
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
      displayEmpty
      size="small"
      value={value.length === 1 ? value[0] : ''}
      onChange={(e) => onChange(e.target.value ? [e.target.value as RaciRole] : [])}
      renderValue={(v) => v || '–'}
      inputProps={{ 'aria-label': label, 'data-testid': testId }}
      sx={{ minWidth: 96, minHeight: phone ? 48 : 40 }}
    >
      <MenuItem value="">–</MenuItem>
      {RACI_ROLES.map((role) => (
        <MenuItem key={role} value={role}>
          <Radio size="small" checked={value.length === 1 && value.includes(role)} sx={{ p: 0.5, mr: 1 }} />
          <ListItemText primary={role} />
        </MenuItem>
      ))}
    </Select>
  )

  // The export shows every task title in full, wrapped at the on-screen column width.
  const doExport = (kind: 'png' | 'pdf') => {
    const el = table.current
    const width = el?.querySelector('tbody th')?.getBoundingClientRect().width
    if (!el || !width) return
    flushSync(() => setExportWidth(width))
    const name = `raci-${projectId}`
    const bg = th.palette.background.paper
    const meta = { title: [projectName, t('RACI')].filter(Boolean).join(' — '), date: new Date(), legend: [], background: bg }
    import('../diagram/export')
      .then((m) => (kind === 'png' ? m.exportElementPng(el, name, bg) : m.exportElementPdf(el, meta, name)))
      .catch((e: unknown) => setError(serializeError(toApiError(e))))
      .finally(() => setExportWidth(null))
  }

  if (!people) return <DiagramLoading />
  const editingTask = editing ? rows.find((task) => task.id === editing) : null
  // A computed parent may sum several children's accountables: only hand-set ones warn.
  const multiA = rows.filter((task) => accountables(task.id, true) > 1)
  const headerStyle = { border: `1px solid ${th.palette.divider}`, padding: th.spacing(0.5, 1), ...wrap } as const
  const menuRoles = menu ? shown(menu.taskId, menu.userId).roles : []
  const menuManualParent = !!menu && tree.kidsOf.has(menu.taskId) && lettersOf(rolesOf(menu.taskId, menu.userId)).length > 0
  const chevron = (task: MatrixTask) =>
    tree.kidsOf.has(task.id) ? (
      <IconButton
        size="small"
        aria-label={`${collapsed.has(task.id) ? t('Expand') : t('Collapse')} ${task.name}`}
        aria-expanded={!collapsed.has(task.id)}
        onClick={() =>
          setCollapsed((c) => {
            const next = new Set(c)
            if (!next.delete(task.id)) next.add(task.id)
            return next
          })
        }
        sx={{ p: 0.25, mr: 0.5, width: phone ? 40 : 24, height: phone ? 40 : 24 }}
      >
        <FontAwesomeIcon icon={byPrefixAndName.fas[collapsed.has(task.id) ? 'chevron-right' : 'chevron-down']} style={{ fontSize: 12 }} />
      </IconButton>
    ) : (
      <Box component="span" sx={{ display: 'inline-block', width: phone ? 40 : 24, mr: 0.5, flexShrink: 0 }} />
    )
  const indent = (task: MatrixTask) => ({ pl: depthOf(task.id) * 2 })

  return (
    <Box sx={{ pt: 0.5 }}>
      <ErrorAlert error={error} />
      {multiA.length ? (
        <Alert severity="warning" data-testid="raci-multi-accountable" sx={{ mb: 1 }}>
          {`${t('Several people accountable')}: ${multiA.map((task) => task.name).join(', ')}`}
        </Alert>
      ) : null}
      {parents.length ? (
        <Stack direction="row" spacing={1} useFlexGap sx={{ mb: 1, flexWrap: 'wrap', alignItems: 'center' }}>
          <Select
            displayEmpty
            size="small"
            value={parents.some((task) => task.id === root) ? root : ''}
            onChange={(e) => {
              setRoot(e.target.value)
              setPicked([])
            }}
            inputProps={{ 'aria-label': t('Parent task'), 'data-testid': 'raci-parent' }}
            sx={{ minWidth: 200, maxWidth: phone ? '100%' : 360, minHeight: phone ? 48 : 40 }}
          >
            <MenuItem value="">{t('All tasks')}</MenuItem>
            {parents.map((task) => (
              <MenuItem key={task.id} value={task.id} sx={{ pl: 2 + tree.ancestors(task.id).length * 2 }}>
                {clip([task.wbs_number, task.name].filter(Boolean).join(' '))}
              </MenuItem>
            ))}
          </Select>
          <Button size="small" onClick={() => setCollapsed(new Set())} disabled={!collapsed.size} sx={{ minHeight: phone ? 40 : undefined }}>
            {t('Expand all')}
          </Button>
          <Button size="small" onClick={() => setCollapsed(new Set(parents.map((task) => task.id)))} sx={{ minHeight: phone ? 40 : undefined }}>
            {t('Collapse all')}
          </Button>
        </Stack>
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
              {rolesSelect(bulkRoles, setBulkRoles, t('Role'), 'raci-bulk-roles')}
              <Button size="small" variant="contained" disabled={!bulkUser || picked.length === 0} onClick={() => void applyBulk()}>
                {`${t('Apply')} (${picked.length})`}
              </Button>
            </>
          ) : null}
        </Stack>
      ) : null}
      {!phone && rows.length ? (
        <Stack direction="row" sx={{ mb: 1, justifyContent: 'flex-end' }}>
          <ExportMenu
            disabled={exportWidth !== null}
            options={[
              { key: 'png', label: t('Export PNG'), icon: 'file-image', onClick: () => doExport('png') },
              { key: 'pdf', label: t('Export PDF'), icon: 'file-pdf', onClick: () => doExport('pdf') },
            ]}
          />
        </Stack>
      ) : null}
      {phone ? (
        <Box data-testid="raci-cards">
          {rows.map((task) => (
            <Box key={task.id} data-testid={`raci-card-${task.id}`} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1, mb: 1, bgcolor: 'background.paper' }}>
              <Stack direction="row" sx={{ alignItems: 'center', ...indent(task) }}>
                {chevron(task)}
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
                  {`${role}: ${people.filter((p) => shown(task.id, p.id).roles.includes(role)).map((p) => p.label + (shown(task.id, p.id).computed ? '*' : '')).join(', ') || '–'}`}
                </Typography>
              ))}
              {people.some((p) => shown(task.id, p.id).computed) ? (
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                  {`* ${t('Computed from subtasks')}`}
                </Typography>
              ) : null}
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
          <table ref={table} style={{ borderCollapse: 'collapse', width: 'max-content' }}>
            <thead data-testid="raci-header">
              <tr>
                <th style={{ ...headerStyle, textAlign: 'left' }} aria-label="corner" />
                {people.map((p) => (
                  <th key={p.id} data-testid={`raci-col-${p.id}`} title={p.label} style={{ ...headerStyle, minWidth: 96, maxWidth: '40ch', whiteSpace: 'nowrap', verticalAlign: 'bottom' }}>
                    {clip(p.label)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((task) => (
                <tr key={task.id}>
                  <th data-testid={`raci-row-${task.id}`} style={{
                      ...headerStyle,
                      textAlign: 'left',
                      minWidth: 160,
                      maxWidth: 280,
                      fontWeight: 'normal',
                      ...(exportWidth ? { boxSizing: 'border-box', width: exportWidth, minWidth: exportWidth, maxWidth: exportWidth } : {}),
                    }}
                  >
                    <Stack direction="row" sx={{ alignItems: 'flex-start', ...indent(task) }}>
                      {chevron(task)}
                      {rowCheckbox(task.id, task.name)}
                      <Box>
                        <Tooltip title={task.name} placement="right">
                          <span data-testid={`raci-name-${task.id}`}>{exportWidth ? task.name : clip(task.name)}</span>
                        </Tooltip>
                        {!accountables(task.id) ? (
                          <Typography variant="caption" color="warning.main" sx={{ display: 'block' }}>
                            {t('No one accountable')}
                          </Typography>
                        ) : null}
                      </Box>
                    </Stack>
                  </th>
                  {people.map((p) => {
                    const cell = shown(task.id, p.id)
                    const letters = cell.roles.join('/')
                    // A computed parent cell reads muted and italic, so a hand-set one stands out.
                    const computedStyle = cell.computed ? { fontStyle: 'italic', color: th.palette.text.secondary } : undefined
                    const title = cell.computed ? t('Computed from subtasks') : undefined
                    return (
                      <td key={p.id} style={{ width: 44, height: 44, border: `1px solid ${th.palette.divider}` }}>
                        {canWrite ? (
                          <Button
                            data-testid={`raci-cell-${task.id}-${p.id}`}
                            data-computed={cell.computed || undefined}
                            size="small"
                            aria-haspopup="menu"
                            aria-label={`${task.name} – ${p.label}${title ? ` (${title})` : ''}`}
                            title={title}
                            onClick={(e) => setMenu({ anchor: e.currentTarget, taskId: task.id, userId: p.id })}
                            sx={{ width: '100%', height: '100%', minWidth: 32, minHeight: 32, p: 0, fontWeight: 'medium' }}
                            style={computedStyle}
                          >
                            {letters}
                          </Button>
                        ) : (
                          <span data-testid={`raci-cell-${task.id}-${p.id}`} data-computed={cell.computed || undefined} title={title} style={computedStyle}>
                            {letters}
                          </span>
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
            <Radio size="small" checked={menuRoles.length === 1 && menuRoles.includes(role)} sx={{ p: 0.5, mr: 1 }} />
            <ListItemText primary={role} />
          </MenuItem>
        ))}
        {menuManualParent ? (
          <MenuItem
            onClick={() => {
              if (menu) void setRoles(menu.taskId, menu.userId, [])
              setMenu(null)
            }}
          >
            <ListItemText primary={t('Use computed values')} />
          </MenuItem>
        ) : null}
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
