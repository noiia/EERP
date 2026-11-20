import { describe, expect, it, vi } from 'vitest'
import { diagramSources, loadDiagram, parseSpec, type DiagramSpec } from './model'
import type { ViewDescriptor } from '../descriptor'
import type { RelationOps } from '../relation-ops'

const projectId = 'aaaaaaaa-1111-4111-8111-111111111111'
const descriptor: ViewDescriptor = {
  entity: 'task',
  navLabel: 'Tasks',
  viewType: 'tree',
  permissions: ['task:task:read'],
  fields: [
    {
      name: 'project_id',
      type: 'relation',
      relation: { entity: 'project', kind: 'many2one', labelField: 'name' },
    },
  ],
  listFilter: { filter: { assignee: 'me' } },
  viewModeDefaults: {
    wbsParentField: 'parent_id',
    wbsGroupField: 'project_id',
    ganttStartField: 'start',
    ganttEndField: 'end',
    pertDependencies: { entity: 'dependency', fromField: 'from_id', toField: 'to_id' },
    risk: {
      entity: 'risk',
      projectField: 'project_id',
      categoryEntity: 'category',
      linkEntity: 'risk_task',
      formPath: '/risks/:id',
    },
  },
}
const routes = new Map([['/tasks', { descriptor }]])
const source = diagramSources(routes, ['*:*:*'])[0]
const spec: DiagramSpec = {
  version: 1,
  source: '/tasks',
  projectId,
  kind: 'gantt',
  title: 'Planning',
  residual: false,
}
function ops(): RelationOps {
  return {
    get: vi.fn().mockResolvedValue({ id: projectId, name: 'Project' }),
    listPage: vi.fn().mockResolvedValue({ records: [], total: 999, totalEstimated: true }),
    list: vi.fn(),
    create: vi.fn(),
    remove: vi.fn(),
  }
}

describe('Office diagram specifications and reads', () => {
  it('discovers only concrete, permitted, project-scoped module views', () => {
    expect(diagramSources(routes, [])).toEqual([])
    expect(diagramSources(new Map([['/tasks/:id', { descriptor }]]), ['*:*:*'])).toEqual([])
    expect(source.kinds).toEqual(['gantt', 'wbs', 'pert', 'risk', 'ishikawa', 'register'])
  })
  it('validates untrusted embedded settings and drops extra fields', () => {
    expect(parseSpec(JSON.stringify({ ...spec, entity: 'users' }))).toEqual(spec)
    for (const change of [
      { projectId: '../users' },
      { kind: 'script' },
      { version: 2 },
      { residual: 'yes' },
      { title: 'x'.repeat(161) },
    ])
      expect(parseSpec(JSON.stringify({ ...spec, ...change }))).toBeNull()
    expect(parseSpec('{')).toBeNull()
    expect(parseSpec(null)).toBeNull()
  })
  it('preserves module filters and pins the project without writes', async () => {
    const api = ops()
    const result = await loadDiagram(api, source, spec)
    expect(api.listPage).toHaveBeenCalledWith(
      'task',
      expect.objectContaining({ filter: { assignee: 'me', project_id: projectId } }),
    )
    expect(result).toMatchObject({ project: 'Project', truncated: false, rows: [] })
    expect(api.create).not.toHaveBeenCalled()
    expect(api.remove).not.toHaveBeenCalled()
    await expect(loadDiagram(api, source, { ...spec, source: '/users' })).rejects.toThrow(
      'Unsupported diagram',
    )
  })
  it('detects truncated snapshots independently of estimated totals', async () => {
    const api = ops()
    vi.mocked(api.listPage!).mockImplementation(async (_, o) => ({
      records: Array.from({ length: o?.page === 3 ? 1 : 100 }, (_, i) => ({
        id: `${o?.page}-${i}`,
      })),
      total: 1,
      totalEstimated: true,
    }))
    const result = await loadDiagram(api, source, spec)
    expect(result.rows).toHaveLength(200)
    expect(result.truncated).toBe(true)
    expect(api.listPage).toHaveBeenCalledTimes(3)
  })
  it('never reads dependencies outside the selected records', async () => {
    const api = ops()
    vi.mocked(api.listPage!).mockImplementation(async (e) => ({
      records:
        e === 'task'
          ? [{ id: 'a' }, { id: 'b' }]
          : [
              { id: 'd', from_id: 'a', to_id: 'b' },
              { id: 'outside', from_id: 'other', to_id: 'b' },
            ],
      total: 2,
    }))
    const result = await loadDiagram(api, source, { ...spec, kind: 'pert' })
    expect(api.listPage).toHaveBeenCalledWith(
      'dependency',
      expect.objectContaining({ in: { to_id: ['a', 'b'] } }),
    )
    expect(result.links).toEqual([{ from: 'a', to: 'b' }])
  })
  it('uses project-scoped risk entities and only referenced categories', async () => {
    const api = ops()
    vi.mocked(api.listPage!).mockImplementation(async (e) => ({
      records:
        e === 'risk'
          ? [{ id: 'r', category_id: 'category-a' }]
          : [{ id: 'category-a', name: 'Technical' }],
      total: 1,
    }))
    const result = await loadDiagram(api, source, { ...spec, kind: 'ishikawa' })
    expect(api.listPage).toHaveBeenCalledWith(
      'risk',
      expect.objectContaining({ filter: { project_id: projectId } }),
    )
    expect(api.listPage).toHaveBeenCalledWith(
      'category',
      expect.objectContaining({ in: { id: ['category-a'] } }),
    )
    expect(result.categories).toEqual([{ id: 'category-a', name: 'Technical' }])
  })
  it('reads the register with its categories and responsible names', async () => {
    const api = ops()
    vi.mocked(api.listPage!).mockImplementation(async (e) => ({
      records:
        e === 'risk'
          ? [
              { id: 'r', category_id: 'category-a', responsible_id: 'u1' },
              { id: 's', responsible_id: 'gone' },
            ]
          : e === 'users'
            ? [{ id: 'u1', display_name: 'Alice' }]
            : [{ id: 'category-a', name: 'Technical' }],
      total: 1,
    }))
    const result = await loadDiagram(api, source, { ...spec, kind: 'register' })
    expect(api.listPage).toHaveBeenCalledWith('users', expect.objectContaining({ in: { id: ['u1', 'gone'] } }))
    expect(result.categories).toEqual([{ id: 'category-a', name: 'Technical' }])
    expect(result.rows.map((r) => r.responsible_name)).toEqual(['Alice', ''])
  })
})
