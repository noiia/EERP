import type { ViewDescriptor } from '../descriptor'
import type { ViewModeDefaults } from '../../api/view-fields'
import type { EntityListOptions } from '../../api/list-options'
import type { RelationOps, RelationRecord } from '../relation-ops'
import { hasPermission } from '../../auth/permissions'

export const diagramKinds = ['gantt', 'wbs', 'pert', 'pbs', 'obs', 'risk', 'ishikawa', 'register'] as const
export type DiagramKind = (typeof diagramKinds)[number]
export const diagramLabels: Record<DiagramKind, string> = {
  gantt: 'Gantt',
  wbs: 'WBS',
  pert: 'PERT',
  pbs: 'PBS',
  obs: 'OBS',
  risk: 'Risk matrix',
  ishikawa: 'Ishikawa',
  register: 'Risk register',
}
export interface DiagramSpec {
  version: 1
  source: string
  projectId: string
  kind: DiagramKind
  title: string
  residual: boolean
}
export interface DiagramSource {
  path: string
  label: string
  descriptor: ViewDescriptor
  defaults: ViewModeDefaults
  scopeField: string
  scopeEntity: string
  labelField: string
  kinds: DiagramKind[]
}
export interface DiagramData {
  rows: RelationRecord[]
  links: { from: string; to: string }[]
  categories: { id: string; name: string }[]
  project: string
  loadedAt: Date
  truncated: boolean
}
export const RECORD_LIMIT = 200
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const text = (v: unknown) => (typeof v === 'string' ? v : '')

// A document may carry an old or untrusted OLE payload. It can select only
// installed descriptors, never endpoints, arbitrary entities or query filters.
export function parseSpec(value: unknown): DiagramSpec | null {
  if (typeof value !== 'string' || value.length > 4096) return null
  try {
    const v = JSON.parse(value)
    if (
      !v ||
      v.version !== 1 ||
      typeof v.source !== 'string' ||
      v.source.length > 240 ||
      !uuid.test(v.projectId) ||
      !diagramKinds.includes(v.kind) ||
      typeof v.title !== 'string' ||
      v.title.length > 160 ||
      typeof v.residual !== 'boolean'
    )
      return null
    return {
      version: 1,
      source: v.source,
      projectId: v.projectId,
      kind: v.kind,
      title: v.title,
      residual: v.residual,
    }
  } catch {
    return null
  }
}

export function diagramSources(
  routes: Map<string, { descriptor: ViewDescriptor; permission?: string }>,
  permissions: string[],
): DiagramSource[] {
  const sources: DiagramSource[] = []
  for (const [path, route] of routes) {
    const d = route.descriptor
    const m = d.viewModeDefaults
    if (
      d.viewType !== 'tree' ||
      path.includes(':') ||
      !m ||
      (route.permission && !hasPermission(permissions, route.permission))
    )
      continue
    if (d.permissions?.some((p) => !hasPermission(permissions, p))) continue
    const scopeField = m.ganttSchedule?.scopeField ?? m.wbsGroupField
    const relation = d.fields.find((f) => f.name === scopeField)?.relation
    if (!scopeField || relation?.kind !== 'many2one') continue
    const kinds = diagramKinds.filter((k) =>
      k === 'gantt'
        ? m.ganttStartField && m.ganttEndField
        : k === 'wbs'
          ? m.wbsParentField
          : k === 'pert'
            ? m.pertDependencies
            : k === 'pbs'
              ? m.pbs
              : k === 'obs'
                ? m.obs
                : m.risk,
    )
    // Equivalent filtered lists keep their own declared filters. This permits
    // "My tasks" while the standard task list remains the default source.
    if (kinds.length)
      sources.push({
        path,
        label: d.navLabel ?? d.entity,
        descriptor: d,
        defaults: m,
        scopeField,
        scopeEntity: relation.entity,
        labelField: relation.labelField ?? 'name',
        kinds,
      })
  }
  return sources
}

async function boundedRows(ops: RelationOps, entity: string, options: EntityListOptions) {
  if (!ops.listPage) throw new Error('Paginated reads unavailable')
  const rows: RelationRecord[] = []
  // Stable ordering and a probe page: estimated totals cannot conceal truncation.
  for (let page = 1; page <= 3; page++) {
    const result = await ops.listPage(entity, { ...options, order: 'id', page, pageSize: 100 })
    const room = RECORD_LIMIT - rows.length
    rows.push(...result.records.slice(0, room))
    if (result.records.length > room) return { rows, truncated: true }
    if (result.records.length < 100) return { rows, truncated: false }
  }
  return { rows, truncated: false }
}

export async function loadDiagram(
  ops: RelationOps,
  source: DiagramSource,
  spec: DiagramSpec,
): Promise<DiagramData> {
  if (
    !parseSpec(JSON.stringify(spec)) ||
    source.path !== spec.source ||
    !source.kinds.includes(spec.kind)
  )
    throw new Error('Unsupported diagram')
  const m = source.defaults
  const config =
    spec.kind === 'pbs'
      ? m.pbs
      : spec.kind === 'obs'
        ? m.obs
        : spec.kind === 'risk' || spec.kind === 'ishikawa' || spec.kind === 'register'
          ? m.risk
          : null
  const entity = config?.entity ?? source.descriptor.entity
  const options = config
    ? { filter: { [config.projectField]: spec.projectId } }
    : {
        ...source.descriptor.listFilter,
        filter: { ...source.descriptor.listFilter?.filter, [source.scopeField]: spec.projectId },
      }
  const [project, result] = await Promise.all([
    ops.get(source.scopeEntity, spec.projectId),
    boundedRows(ops, entity, options),
  ])
  const data: DiagramData = {
    ...result,
    project: text(project[source.labelField]) || spec.projectId,
    categories: [],
    links: [],
    loadedAt: new Date(),
  }
  const ids = result.rows.map((r) => r.id)
  const deps =
    spec.kind === 'pert' ? m.pertDependencies : spec.kind === 'gantt' ? m.ganttDependencies : null
  if (deps && ids.length) {
    const found = await boundedRows(ops, deps.entity, { in: { [deps.toField]: ids } })
    const known = new Set(ids)
    data.links = found.rows
      .map((r) => ({ from: text(r[deps.fromField]), to: text(r[deps.toField]) }))
      .filter((l) => known.has(l.from) && known.has(l.to))
    data.truncated ||= found.truncated
  }
  if ((spec.kind === 'ishikawa' || spec.kind === 'register') && m.risk) {
    const categories = [...new Set(result.rows.map((r) => text(r.category_id)).filter(Boolean))]
    if (categories.length) {
      const found = await boundedRows(ops, m.risk.categoryEntity, { in: { id: categories } })
      data.categories = found.rows.map((r) => ({ id: r.id, name: text(r.name) }))
      data.truncated ||= found.truncated
    }
  }
  // The register names each risk's responsible user (a label only, never the account).
  if (spec.kind === 'register') {
    const refs = [...new Set(result.rows.map((r) => text(r.responsible_id)).filter(Boolean))]
    if (refs.length) {
      const found = await boundedRows(ops, 'users', { in: { id: refs } })
      const names = new Map(found.rows.map((r) => [r.id, text(r.display_name) || text(r.email)]))
      data.rows = result.rows.map((r) => ({ ...r, responsible_name: names.get(text(r.responsible_id)) ?? '' }))
      data.truncated ||= found.truncated
    }
  }
  if (spec.kind === 'obs' && ids.length) {
    const labels = new Map<string, string>()
    for (const kind of ['contact', 'user']) {
      const refs = [
        ...new Set(
          result.rows
            .filter((r) => r.kind === kind)
            .map((r) => text(r[`${kind}_id`]))
            .filter(Boolean),
        ),
      ]
      if (!refs.length) continue
      const found = await boundedRows(ops, kind === 'user' ? 'users' : 'contact', {
        in: { id: refs },
      })
      found.rows.forEach((r) =>
        labels.set(`${kind}:${r.id}`, text(r.display_name) || text(r.name) || text(r.email)),
      )
    }
    data.rows = result.rows.map((r) => ({
      ...r,
      name: text(r.title),
      detail:
        r.kind === 'text' ? text(r.text) : (labels.get(`${r.kind}:${r[`${r.kind}_id`]}`) ?? '—'),
    }))
  }
  return data
}
