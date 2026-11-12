'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Typography from '@mui/material/Typography'
import type { Edge, Node } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { serializeError, toApiError, type SerializedError } from '../../api/errors'
import type { EntityListOptions } from '../../api/list-options'
import { useT } from '../../i18n/translate'
import { erpPath } from '../../navigation'
import { moduleRegistry } from '../../registry'
import type { FieldDescriptor, ViewDescriptor } from '../descriptor'
import { ErrorAlert } from '../error-alert'
import type { EntityActions, HasId } from '../stores'
import { useRelationLabels } from '../use-relation-labels'
import { layoutWbs } from './auto-layout'
import { DiagramCanvas, DiagramCapNotice, useDiagramRecords } from './diagram-canvas'
import { TASK_BOX_SIZE, type LabelBoxData, type TaskBoxData } from './task-box'
import { buildWbs, canReparent } from './wbs'

// WBS display mode: the records as a top-down tree over `parentField`, under one
// read-only root per `groupField` value. Boxes edit their fields in place, parents
// fold (the folds ride the canvas's saved layout), and a box dropped on another one
// is re-parented there (on a group root: parent cleared).

const FOLDED_COLOR = '#ed6c02'
const GROUP = 'group:'

export interface WbsRendererProps<T extends HasId> {
  descriptor: ViewDescriptor
  initialData: T[]
  actions: EntityActions<T>
  parentField: string
  groupField?: string
  /** Fields edited in each box, in order (unknown names and duplicates dropped). Default: name. */
  boxFields?: (string | null | undefined)[]
  /** A number field summed into a folded box's footer. */
  hoursField?: string
  onRecordsChange?: (records: T[]) => void
  serverOptions?: EntityListOptions
}

export function WbsRenderer<T extends HasId>({
  descriptor,
  initialData,
  actions,
  parentField,
  groupField,
  boxFields = ['name'],
  hoursField,
  onRecordsChange,
  serverOptions,
}: WbsRendererProps<T>) {
  const t = useT()
  const router = useRouter()
  const { entity, formPath } = descriptor
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
  const [folded, setFolded] = useState<string[]>([])
  const [error, setError] = useState<SerializedError | null>(null)

  const formFields = moduleRegistry.formDescriptorFor(entity)?.fields ?? []
  const fieldOf = (name: string): FieldDescriptor | undefined =>
    descriptor.fields.find((f) => f.name === name) ?? formFields.find((f) => f.name === name)
  const fields = [...new Set(boxFields.filter((n): n is string => !!n))]
    .map(fieldOf)
    .filter((f): f is FieldDescriptor => !!f)
  const groupDescriptor = groupField ? fieldOf(groupField) : undefined

  const values = (r: T) => r as unknown as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null)
  const foldedSet = new Set(folded)
  const { nodes, roots, visible } = buildWbs(
    rows.map((r) => ({
      id: r.id,
      parentId: str(values(r)[parentField]),
      groupId: groupField ? str(values(r)[groupField]) : null,
      plannedHours: hoursField ? Number(values(r)[hoursField]) || 0 : 0,
    })),
    foldedSet,
  )
  const groupIds = roots.filter((id) => id.startsWith(GROUP))
  const labelOf = useRelationLabels(
    groupDescriptor ? [groupDescriptor] : [],
    groupIds.map((id): [string, unknown] => [groupField!, id.slice(GROUP.length)]),
  )

  const replace = (updated: T) => setRows((prev) => prev.map((r) => (r.id === updated.id ? { ...r, ...updated } : r)))
  const toggle = (id: string) => setFolded((f) => (f.includes(id) ? f.filter((x) => x !== id) : [...f, id]))
  const footer = (id: string) =>
    foldedSet.has(id) ? (
      <Typography variant="caption" sx={{ color: FOLDED_COLOR, display: 'block', mt: 0.5 }}>
        {t('+{n} tasks · {h} h').replace('{n}', String(nodes[id].hiddenCount)).replace('{h}', String(nodes[id].hiddenHours))}
      </Typography>
    ) : undefined
  const chevron = (id: string) =>
    nodes[id].children.length ? { folded: foldedSet.has(id), onToggle: () => toggle(id) } : undefined

  const byId = new Map(rows.map((r) => [r.id, r]))
  const rfNodes: Node[] = visible.map((id) => {
    if (nodes[id].kind === 'group') {
      const data: LabelBoxData = { label: labelOf(groupField!, id.slice(GROUP.length)), chevron: chevron(id), footer: footer(id) }
      return { id, type: 'label', position: { x: 0, y: 0 }, data }
    }
    const record = byId.get(id)!
    const data: TaskBoxData = {
      record: values(record),
      editable: !!actions.update,
      fields,
      onCommit: async (field, value) => {
        replace(await actions.update(id, { [field]: value } as Partial<T>))
      },
      onOpen: () => {
        if (formPath) router.push(erpPath(formPath.replace(':id', id)))
      },
      chevron: chevron(id),
      footer: footer(id),
    }
    return { id, position: { x: 0, y: 0 }, data }
  })
  const shown = new Set(visible)
  const edges: Edge[] = visible.flatMap((id) => {
    const p = nodes[id].parentId
    return p && shown.has(p) ? [{ id: `${p}->${id}`, source: p, target: id, deletable: false }] : []
  })

  // false puts the box back where it was (DiagramCanvas.onNodeDrop).
  const onNodeDrop = (id: string, overId: string | null): boolean | Promise<boolean> => {
    if (overId === null || overId === nodes[id]?.parentId) return true
    if (!canReparent(nodes, id, overId)) return false
    setError(null)
    return actions.update(id, { [parentField]: overId.startsWith(GROUP) ? null : overId } as Partial<T>).then(
      (updated) => {
        replace(updated)
        return true
      },
      (e: unknown) => {
        setError(serializeError(toApiError(e)))
        return false
      },
    )
  }

  if (loaded.capped) return <DiagramCapNotice />
  return (
    <>
      <ErrorAlert error={error ?? (loaded.error ? { code: 'INTERNAL_ERROR', message: loaded.error } : null)} />
      <DiagramCanvas
        entity={entity}
        mode="wbs"
        title={t('WBS')}
        nodes={rfNodes}
        edges={edges}
        autoLayout={() => layoutWbs(nodes, roots, visible, TASK_BOX_SIZE)}
        folded={folded}
        onFoldedChange={setFolded}
        onNodeDrop={onNodeDrop}
        legend={[{ color: FOLDED_COLOR, label: t('Folded branch') }]}
      />
    </>
  )
}
