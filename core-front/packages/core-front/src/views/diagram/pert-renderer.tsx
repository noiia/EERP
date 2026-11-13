'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Chip from '@mui/material/Chip'
import Typography from '@mui/material/Typography'
import { useTheme } from '@mui/material/styles'
import type { Connection, Edge, MarkerType, Node } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { serializeError, toApiError, type SerializedError } from '../../api/errors'
import type { EntityListOptions } from '../../api/list-options'
import type { GanttDependenciesConfig } from '../../api/view-fields'
import { usePermission } from '../../auth/Can'
import { useT } from '../../i18n/translate'
import { erpPath } from '../../navigation'
import type { FieldDescriptor, ViewDescriptor } from '../descriptor'
import { ViewBanner } from '../banner'
import { ErrorAlert } from '../error-alert'
import { formatDatePattern, useFormatStore, useNumberFormat } from '../format-store'
import { useRelationOps } from '../relation-ops'
import type { EntityActions, HasId } from '../stores'
import { layoutPert } from './auto-layout'
import { DiagramCanvas, DiagramCapNotice, DiagramLoading, useDiagramRecords } from './diagram-canvas'
import { computePert, offsetToDate } from './pert'
import { boxFieldOf, TASK_BOX_SIZE, type TaskBoxData } from './task-box'

// PERT display mode: one box per record, an arrow per dependency row (blocker →
// dependent), each box showing its ES/EF/LS/LF dates and slack, the critical path in
// red. Drawing an arrow creates a dependency row, deleting one removes it; box edits
// go through actions.update and the figures recompute from the updated records.

const LINK_CHUNK = 100 // ids per in[] request: 2000 ids don't fit one URL
const LINK_PAGE_SIZE = 200

interface LinkRow { id: string; from: string; to: string }

export interface PertRendererProps<T extends HasId> {
  descriptor: ViewDescriptor
  initialData: T[]
  actions: EntityActions<T>
  dependencies: GanttDependenciesConfig
  startField?: string
  endField?: string
  hoursField?: string
  /** Dotted order number field: the auto-layout runs from the 1.x records to the highest. */
  orderField?: string
  /** Fields edited in each box, in order (unknown names and duplicates dropped). Default: name. */
  boxFields?: (string | null | undefined)[]
  onRecordsChange?: (records: T[]) => void
  serverOptions?: EntityListOptions
}

export function PertRenderer<T extends HasId>({
  descriptor,
  initialData,
  actions,
  dependencies: dep,
  startField,
  endField,
  hoursField,
  orderField,
  boxFields = ['name'],
  onRecordsChange,
  serverOptions,
}: PertRendererProps<T>) {
  const t = useT()
  const router = useRouter()
  const theme = useTheme()
  const red = theme.palette.error.main
  const { format } = useNumberFormat()
  const dateFormat = useFormatStore((s) => s.dateFormat)
  const ops = useRelationOps()
  const { entity, formPath } = descriptor
  const canWrite = usePermission(`${entity}:${entity}:write`)
  // Arrows are rows of the dependency entity: its own write right gates them.
  const canLink = usePermission(`${dep.entity}:${dep.entity}:write`)
  const loaded = useDiagramRecords(entity, serverOptions, initialData)
  const [rows, setRows] = useState(loaded.records)
  const [seen, setSeen] = useState(loaded.records)
  if (seen !== loaded.records) {
    setSeen(loaded.records)
    setRows(loaded.records)
  }
  useEffect(() => {
    onRecordsChange?.(rows)
  }, [rows, onRecordsChange])
  const [error, setError] = useState<SerializedError | null>(null)

  // Dependency rows touching the shown records, read like gantt-renderer's but from
  // both ends (in[toField] and in[fromField], so a link to a hidden record is counted
  // too) by id chunks, each paged until a short page, deduplicated by id; read again
  // only when the id set changes.
  const [links, setLinks] = useState<LinkRow[]>([])
  const listPage = ops?.listPage
  const depKey = JSON.stringify(dep)
  const idsKey = rows.map((r) => r.id).sort().join(',')
  useEffect(() => {
    if (!listPage || idsKey === '') {
      setLinks([])
      return
    }
    const d = JSON.parse(depKey) as GanttDependenciesConfig
    const ids = idsKey.split(',')
    let cancelled = false
    const load = async () => {
      const out = new Map<string, LinkRow>()
      for (const end of [d.toField, d.fromField]) {
        for (let i = 0; i < ids.length; i += LINK_CHUNK) {
          for (let page = 1; ; page++) {
            const res = await listPage(d.entity, { in: { [end]: ids.slice(i, i + LINK_CHUNK) }, order: end, page, pageSize: LINK_PAGE_SIZE })
            for (const r of res.records as Record<string, unknown>[]) out.set(String(r.id), { id: String(r.id), from: String(r[d.fromField]), to: String(r[d.toField]) })
            if (res.records.length < LINK_PAGE_SIZE) break
          }
        }
      }
      return [...out.values()]
    }
    load().then(
      (ls) => !cancelled && setLinks(ls),
      (e: unknown) => !cancelled && setError(serializeError(toApiError(e))),
    )
    return () => {
      cancelled = true
    }
  }, [listPage, depKey, idsKey])

  const fieldOf = boxFieldOf(descriptor)
  const fields = [...new Set(boxFields.filter((n): n is string => !!n))]
    .map(fieldOf)
    .filter((f): f is FieldDescriptor => !!f)

  const values = (r: T) => r as unknown as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null)
  const pert = computePert(
    rows.map((r) => ({
      id: r.id,
      plannedHours: hoursField ? Number(values(r)[hoursField]) || null : null,
      dateStart: startField ? str(values(r)[startField]) : null,
      deadline: endField ? str(values(r)[endField]) : null,
    })),
    links,
  )
  const orderById = new Map(rows.map((r) => [r.id, orderField ? str(values(r)[orderField]) : null]))
  const orderOf = orderField ? (id: string) => orderById.get(id) ?? null : undefined
  const date = (days: number) => formatDatePattern(offsetToDate(pert.origin, days), dateFormat)

  const replace = (updated: T) => setRows((prev) => prev.map((r) => (r.id === updated.id ? { ...r, ...updated } : r)))
  const rfNodes: Node[] = rows.map((record) => {
    const { id } = record
    const n = pert.nodes[id]
    const closed = values(record).closed === true
    const data: TaskBoxData = {
      record: values(record),
      // Zoomed out: "<order> - <name>" like the lists.
      title: [orderById.get(id), str(values(record).name) ?? str(values(record).title)].filter(Boolean).join(' - '),
      editable: canWrite,
      fields,
      onCommit: async (field, value) => {
        replace(await actions.update(id, { [field]: value } as Partial<T>))
      },
      onOpen: () => {
        if (formPath) router.push(erpPath(formPath.replace(':id', id)))
      },
      badges: n.noEstimate ? <Chip size="small" color="warning" label={t('No estimate')} /> : undefined,
      footer: pert.cycle ? undefined : (
        <Typography variant="caption" component="div" color="text.secondary" sx={{ mt: 0.5 }}>
          <div>{`${t('ES')} ${date(n.es)} · ${t('EF')} ${date(n.ef)}`}</div>
          <div>{`${t('LS')} ${date(n.ls)} · ${t('LF')} ${date(n.lf)}`}</div>
          <div>{t('Slack: {n} d').replace('{n}', format(Math.round(n.slack * 10) / 10))}</div>
        </Typography>
      ),
    }
    const critical = !pert.cycle && n.critical
    return {
      id,
      position: { x: 0, y: 0 },
      data,
      className: [critical && 'critical', closed && 'closed'].filter(Boolean).join(' ') || undefined,
      style: {
        ...(critical ? { outline: `2px solid ${red}`, borderRadius: 4 } : {}),
        ...(closed ? { opacity: 0.5 } : {}),
      },
    }
  })
  const shown = new Set(rows.map((r) => r.id))
  const edges: Edge[] = links
    .filter((l) => shown.has(l.from) && shown.has(l.to))
    .map((l) => {
      const critical = pert.criticalLinks.has(`${l.from}->${l.to}`)
      return {
        id: l.id,
        source: l.from,
        target: l.to,
        deletable: canLink,
        className: critical ? 'critical' : undefined,
        markerEnd: { type: 'arrowclosed' as MarkerType, ...(critical ? { color: red } : {}) },
        ...(critical ? { style: { stroke: red, strokeWidth: 2 } } : {}),
      }
    })

  const onConnect = ({ source, target }: Connection) => {
    if (!ops || source === target || links.some((l) => l.from === source && l.to === target)) return
    setError(null)
    ops.create(dep.entity, { [dep.fromField]: source, [dep.toField]: target }).then(
      (created) => setLinks((ls) => [...ls, { id: String(created.id), from: source, to: target }]),
      (e: unknown) => setError(serializeError(toApiError(e))),
    )
  }
  const onEdgesDelete = (deleted: Edge[]) => {
    if (!ops) return
    setError(null)
    for (const e of deleted) {
      ops.remove(dep.entity, e.id).then(
        () => setLinks((ls) => ls.filter((l) => l.id !== e.id)),
        (err: unknown) => setError(serializeError(toApiError(err))),
      )
    }
  }

  if (loaded.capped) return <DiagramCapNotice />
  if (loaded.loading) return <DiagramLoading />
  return (
    <>
      <ErrorAlert error={error ?? (loaded.error ? { code: 'INTERNAL_ERROR', message: loaded.error } : null)} />
      <ViewBanner open={!!pert.cycle} status="warning">{t('Dependency cycle: critical path not computed')}</ViewBanner>
      <DiagramCanvas
        entity={entity}
        mode="pert"
        title={t('PERT')}
        nodes={rfNodes}
        edges={edges}
        autoLayout={() => layoutPert(rows.map((r) => r.id), links, TASK_BOX_SIZE, orderOf)}
        onConnect={canLink ? onConnect : undefined}
        onEdgesDelete={canLink ? onEdgesDelete : undefined}
        legend={[
          { color: red, label: t('Critical path') },
          { color: theme.palette.warning.main, label: t('No estimate') },
          { color: theme.palette.action.disabled, label: t('Closed') },
        ]}
        toolbarExtra={pert.hiddenLinks > 0 ? <Chip size="small" label={pert.hiddenLinks === 1 ? t('1 hidden link') : t('{n} hidden links').replace('{n}', String(pert.hiddenLinks))} /> : undefined}
      />
    </>
  )
}
