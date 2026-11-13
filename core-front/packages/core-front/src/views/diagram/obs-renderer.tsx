'use client'
import { useEffect, useRef, useState } from 'react'
import Autocomplete from '@mui/material/Autocomplete'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import type { Connection, Edge, Node } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { serializeError, toApiError, type SerializedError } from '../../api/errors'
import type { ObsConfig } from '../../api/view-fields'
import { useT } from '../../i18n/translate'
import { BannerScope, BannerSlot } from '../banner'
import { ErrorAlert } from '../error-alert'
import { byPrefixAndName, FontAwesomeIcon } from '../icons'
import { kanbanColumnsGuard } from '../kanban-columns'
import { useRelationOps, type RelationOps, type RelationRecord } from '../relation-ops'
import { layoutWbs } from './auto-layout'
import type { Point } from './collide'
import { DiagramCanvas, DiagramLoading } from './diagram-canvas'
import { OBS_BOX_SIZE, type ObsBoxData, type ObsRow } from './obs-box'
import { buildWbs } from './wbs'

export { OBS_BOX_SIZE }

// OBS display mode: a project's hand-built chart of contact, user and text boxes (one shared
// chart per project, stored as project_obs_box rows), lines from each box to its parent.
// Positions are the rows' own x/y (controlled canvas); a box never placed (0, 0) takes the
// tree layout's spot. Writes need the guard named by config.canEdit; Go re-checks each one.

const PAGE_SIZE = 200
const PICK_SIZE = 20

type Kind = ObsRow['kind']
type Option = { id: string; label: string }
interface Draft { kind: Kind; row?: ObsRow; spot?: Point }

export interface ObsRendererProps {
  config: ObsConfig
  projectId: string
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : null)
const savedPositions = (rows: ObsRow[]) =>
  Object.fromEntries(rows.filter((r) => r.x || r.y).map((r) => [r.id, { x: r.x, y: r.y }]))

export function ObsRenderer({ config, projectId }: ObsRendererProps) {
  const t = useT()
  const ops = useRelationOps()
  const { entity, projectField } = config
  const [rows, setRows] = useState<ObsRow[] | null>(null)
  const [positions, setPositions] = useState<Record<string, Point>>({})
  const [error, setError] = useState<SerializedError | null>(null)
  const [reloads, setReloads] = useState(0)
  const [canEdit, setCanEdit] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const update = ops?.update

  const listPage = ops?.listPage
  useEffect(() => {
    if (!listPage) return
    let cancelled = false
    const load = async () => {
      const out: ObsRow[] = []
      for (let page = 1; ; page++) {
        const res = await listPage(entity, { filter: { [projectField]: projectId }, order: 'created_at', pageSize: PAGE_SIZE, page })
        out.push(...(res.records as unknown as ObsRow[]))
        if (res.records.length < PAGE_SIZE) return out
      }
    }
    load().then(
      (rs) => {
        if (cancelled) return
        setRows(rs)
        setPositions(savedPositions(rs))
      },
      (e: unknown) => {
        if (cancelled) return
        setRows([])
        setError(serializeError(toApiError(e)))
      },
    )
    return () => {
      cancelled = true
    }
  }, [listPage, entity, projectField, projectId, reloads])

  useEffect(() => {
    const guard = config.canEdit ? kanbanColumnsGuard(config.canEdit) : undefined
    if (!guard) return
    let cancelled = false
    guard(projectId, ops).then(
      (ok) => !cancelled && setCanEdit(ok),
      () => !cancelled && setCanEdit(false),
    )
    return () => {
      cancelled = true
    }
  }, [config.canEdit, projectId, ops])
  const editable = canEdit && !!update

  if (!rows) return <DiagramLoading />
  const ids = new Set(rows.map((r) => r.id))
  const fail = (e: unknown) => setError(serializeError(toApiError(e)))
  const replace = (r: RelationRecord) => setRows((rs) => rs!.map((x) => (x.id === r.id ? { ...x, ...(r as unknown as ObsRow) } : x)))
  const patch = (id: string, body: Record<string, unknown>) => {
    setError(null)
    return update!(entity, id, body).then(replace)
  }

  const nodes: Node[] = rows.map((row) => ({
    id: row.id,
    type: 'obs',
    position: { x: 0, y: 0 },
    width: OBS_BOX_SIZE.w,
    height: OBS_BOX_SIZE.h,
    data: {
      row,
      editable,
      onColor: (color) => patch(row.id, { color }).catch(fail),
      onDelete: () => {
        setError(null)
        ops!.remove(entity, row.id).then(() => setReloads((n) => n + 1), fail)
      },
      onEdit: () => setDraft({ kind: row.kind, row }),
    } satisfies ObsBoxData,
  }))
  const edges: Edge[] = rows
    .filter((r) => r.parent_id && ids.has(r.parent_id))
    .map((r) => ({ id: `${r.parent_id}->${r.id}`, source: r.parent_id!, target: r.id, type: 'smoothstep', deletable: editable }))

  const autoLayout = () => {
    const tree = buildWbs(rows.map((r) => ({ id: r.id, parentId: r.parent_id && ids.has(r.parent_id) ? r.parent_id : null })), new Set())
    return layoutWbs(tree.nodes, tree.roots, tree.visible, OBS_BOX_SIZE)
  }

  const onConnect = ({ source, target }: Connection) => {
    if (source !== target) patch(target, { parent_id: source }).catch(fail)
  }
  const onEdgesDelete = (deleted: Edge[]) => {
    for (const e of deleted) patch(e.target, { parent_id: null }).catch(fail)
  }
  // Positions move first (the controlled canvas draws only these); refused ones go back.
  const onMove = async (moved: Record<string, Point>) => {
    const before = positions
    setError(null)
    setPositions((p) => ({ ...p, ...moved }))
    const done = await Promise.allSettled(Object.entries(moved).map(([id, p]) => update!(entity, id, { x: p.x, y: p.y })))
    const failed = Object.keys(moved).filter((_, i) => done[i].status === 'rejected')
    if (!failed.length) return true
    setPositions((p) => {
      const next = { ...p }
      for (const id of failed) {
        // A later drop of the same box has moved it since: that one wins.
        if (next[id]?.x !== moved[id].x || next[id]?.y !== moved[id].y) continue
        if (before[id]) next[id] = before[id]
        else delete next[id]
      }
      return next
    })
    fail((done.find((d) => d.status === 'rejected') as PromiseRejectedResult).reason)
    return false
  }

  const submit = async ({ ref, title, text }: { ref: string | null; title: string; text: string }) => {
    const d = draft!
    const body: Record<string, unknown> = d.kind === 'text' ? { title, text } : { title }
    if (d.row) {
      await update!(entity, d.row.id, body).then(replace)
      return
    }
    const spot = d.spot ?? { x: 0, y: 0 }
    const created = await ops!.create(entity, {
      [projectField]: projectId,
      kind: d.kind,
      ...(d.kind === 'contact' ? { contact_id: ref } : d.kind === 'user' ? { user_id: ref } : {}),
      title,
      text: d.kind === 'text' ? text : '',
      ...spot,
    })
    setRows((rs) => [...rs!, created as unknown as ObsRow])
    setPositions((p) => ({ ...p, [String(created.id)]: spot }))
  }

  const addButtons = (centerSpot: (size: { w: number; h: number }) => Point) => (
    <>
      {([['contact', 'address-book', t('Add contact')], ['user', 'user', t('Add user')], ['text', 'font', t('Add text')]] as const).map(([kind, icon, label]) => (
        <Button key={kind} size="small" startIcon={<FontAwesomeIcon icon={byPrefixAndName.fas[icon]} />} onClick={() => setDraft({ kind, spot: centerSpot(OBS_BOX_SIZE) })}>
          {label}
        </Button>
      ))}
    </>
  )

  return (
    <>
      <ErrorAlert error={error} />
      <DiagramCanvas
        entity={entity}
        mode="obs"
        title={t('OBS')}
        nodes={nodes}
        edges={edges}
        autoLayout={autoLayout}
        positions={positions}
        onMove={editable ? onMove : undefined}
        onConnect={editable ? onConnect : undefined}
        onEdgesDelete={editable ? onEdgesDelete : undefined}
        readOnly={!editable}
        legend={[]}
        toolbarExtra={editable ? addButtons : undefined}
      />
      {draft && ops ? <ObsBoxDialog draft={draft} ops={ops} config={config} projectId={projectId} onSubmit={submit} onClose={() => setDraft(null)} /> : null}
    </>
  )
}

/** People to pick: a contact of the project's company (any person when it has none), or a user. */
function usePicker(kind: Kind, ops: RelationOps, config: ObsConfig, projectId: string) {
  const project = useRef<Promise<RelationRecord> | null>(null)
  return async (q: string): Promise<Option[]> => {
    const listPage = ops.listPage
    if (!listPage) return []
    const rows = (res: { records: RelationRecord[] }) => res.records as Record<string, unknown>[]
    if (kind === 'user') {
      const res = await listPage('users', { ...(q ? { search: { email: q } } : {}), pageSize: PICK_SIZE })
      return rows(res).map((r) => ({ id: String(r.id), label: str(r.display_name) ? `${str(r.display_name)} (${String(r.email ?? '')})` : String(r.email ?? r.id) }))
    }
    project.current ??= ops.get(config.projectEntity, projectId)
    const company = str((await project.current)[config.companyField])
    const search = q ? { search: { name: q } } : {}
    let res
    if (company) {
      // shortcut: one page of a company's people (200), page on if a company ever has more.
      const links = await listPage('contact_company', { filter: { company_id: company }, pageSize: PAGE_SIZE })
      const people = rows(links).map((l) => String(l.contact_id))
      if (!people.length) return []
      res = await listPage('contact', { in: { id: people }, ...search, pageSize: PICK_SIZE })
    } else {
      res = await listPage('contact', { filter: { kind: 'contact' }, ...search, pageSize: PICK_SIZE })
    }
    return rows(res).map((r) => ({ id: String(r.id), label: [str(r.name), str(r.email) && `(${str(r.email)})`].filter(Boolean).join(' ') || String(r.id) }))
  }
}

function ObsBoxDialog({ draft, ops, config, projectId, onSubmit, onClose }: {
  draft: Draft
  ops: RelationOps
  config: ObsConfig
  projectId: string
  /** Rejects with the refusal, shown in the dialog. */
  onSubmit: (v: { ref: string | null; title: string; text: string }) => Promise<void>
  onClose: () => void
}) {
  const t = useT()
  const { kind, row } = draft
  const [title, setTitle] = useState(row?.title ?? '')
  const [text, setText] = useState(row?.text ?? '')
  const [picked, setPicked] = useState<Option | null>(null)
  const [options, setOptions] = useState<Option[]>([])
  const [error, setError] = useState<SerializedError | null>(null)
  const [busy, setBusy] = useState(false)
  const pick = usePicker(kind, ops, config, projectId)
  const find = (q: string) => pick(q).then(setOptions, (e: unknown) => setError(serializeError(toApiError(e))))
  const needsRef = !row && kind !== 'text'
  const heading = row ? t('Edit box') : kind === 'contact' ? t('Add contact') : kind === 'user' ? t('Add user') : t('Add text')

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await onSubmit({ ref: picked?.id ?? null, title: title.trim(), text })
      onClose()
    } catch (e: unknown) {
      setError(serializeError(toApiError(e)))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth>
      <BannerScope>
        <Box>
          <DialogTitle>{heading}</DialogTitle>
          <DialogContent>
            <Stack spacing={2} sx={{ pt: 1 }}>
              <BannerSlot sx={{ mb: 0 }} />
              <ErrorAlert error={error} />
              {needsRef ? (
                <Autocomplete
                  options={options}
                  value={picked}
                  onChange={(_, v) => setPicked(v)}
                  onOpen={() => void find('')}
                  onInputChange={(_, q, reason) => {
                    if (reason === 'input') void find(q)
                  }}
                  filterOptions={(o) => o} // the server already searched
                  getOptionLabel={(o) => o.label}
                  isOptionEqualToValue={(a, b) => a.id === b.id}
                  noOptionsText={t('No results')}
                  renderInput={(params) => <TextField {...params} label={kind === 'contact' ? t('Contact') : t('User')} />}
                />
              ) : null}
              <TextField label={t('Role')} value={title} onChange={(e) => setTitle(e.target.value)} slotProps={{ htmlInput: { maxLength: 200 } }} />
              {kind === 'text' ? (
                <TextField label={t('Text')} value={text} onChange={(e) => setText(e.target.value)} multiline minRows={3} slotProps={{ htmlInput: { maxLength: 2000 } }} />
              ) : null}
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={onClose}>{t('Cancel')}</Button>
            <Button variant="contained" onClick={() => void save()} disabled={busy || (needsRef && !picked)}>
              {row ? t('Save') : t('Create')}
            </Button>
          </DialogActions>
        </Box>
      </BannerScope>
    </Dialog>
  )
}
