import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { DiagramPreview } from './preview'
import { diagramKinds, diagramSources, type DiagramData, type DiagramSpec } from './model'

const source = diagramSources(
  new Map([
    [
      '/tasks',
      {
        descriptor: {
          entity: 'task',
          viewType: 'tree',
          fields: [
            {
              name: 'project_id',
              type: 'relation',
              relation: { kind: 'many2one', entity: 'project' },
            },
          ],
          viewModeDefaults: {
            wbsGroupField: 'project_id',
            wbsParentField: 'parent_id',
            ganttStartField: 'start',
            ganttEndField: 'end',
            pertHoursField: 'hours',
            pertDependencies: { entity: 'dependency', fromField: 'from_id', toField: 'to_id' },
          },
        },
      },
    ],
  ]),
  [],
)[0]
const spec: DiagramSpec = {
  version: 1,
  source: '/tasks',
  projectId: 'aaaaaaaa-1111-4111-8111-111111111111',
  kind: 'gantt',
  title: 'Planning <script>',
  residual: false,
}
const data: DiagramData = {
  project: 'Project',
  loadedAt: new Date('2026-11-19T10:00:00Z'),
  truncated: false,
  links: [{ from: 'a', to: 'b' }],
  categories: [{ id: 'technical', name: 'Technical' }],
  rows: [
    {
      id: 'a',
      name: 'Design',
      start: '2026-11-01',
      end: '2026-11-05',
      hours: 16,
      likelihood: 3,
      severity_effective: 4,
      residual_likelihood: 1,
      residual_severity: 2,
      category_id: 'technical',
    },
    { id: 'b', name: 'Develop', parent_id: 'a', start: '2026-11-06', end: '2026-11-12', hours: 24 },
  ],
}
const draw = (kind: DiagramSpec['kind'], input = data, residual = false) =>
  renderToStaticMarkup(
    <DiagramPreview data={input} source={source} spec={{ ...spec, kind, residual }} t={(s) => s} />,
  )

describe('Embedded Office diagram previews', () => {
  it.each(diagramKinds)('renders %s as a self-contained, safe snapshot', (kind) => {
    const svg = draw(kind)
    expect(svg).toContain('<svg')
    expect(svg).toContain('Snapshot')
    expect(svg).toContain('Planning &lt;script&gt;')
    expect(svg).not.toContain('<script')
    expect(svg).not.toContain('<foreignObject')
    expect(svg).not.toContain('href=')
    expect(svg).not.toContain('NaN')
    expect(svg).not.toContain('Infinity')
  })
  it('uses the ERP risk scales and exposes missing scores and residual mode', () => {
    const svg = draw('risk')
    expect(svg).toContain('Design')
    expect(svg).toContain('Unscored risks: 1')
    expect(svg).toContain('Current risk')
    expect(draw('risk', data, true)).toContain('Residual risk')
  })
  it('draws the register as a table, most critical first, with names instead of ids', () => {
    const svg = draw('register', {
      ...data,
      rows: [
        { id: 'a', name: 'Low one', criticity: 2, impact_on: 'cost' },
        { id: 'b', name: 'High one', criticity: 18, category_id: 'technical', responsible_id: 'u1', responsible_name: 'Alice', deadline: '2026-12-01T00:00:00Z' },
      ],
    })
    expect(svg).toContain('>Residual</text>')
    expect(svg).toContain('>criticity</text>')
    expect(svg.indexOf('High one')).toBeLessThan(svg.indexOf('Low one'))
    expect(svg).toContain('Technical')
    expect(svg).toContain('Alice')
    expect(svg).not.toContain('u1')
    expect(svg).toContain('2026-12-01')
    expect(svg).toContain('Cost')
  })
  it('marks partial data and PERT cycles in the exported image itself', () => {
    expect(
      draw('pert', { ...data, truncated: true, links: [...data.links, { from: 'b', to: 'a' }] }),
    ).toContain('Dependency cycle: critical path unavailable')
    expect(draw('wbs', { ...data, truncated: true })).toContain(
      'Partial diagram: record limit reached',
    )
  })
  it('explains missing dates and empty diagrams', () => {
    expect(draw('gantt', { ...data, rows: [{ id: 'a', name: 'Unscheduled' }] })).toContain(
      'No scheduled tasks',
    )
    expect(draw('gantt', { ...data, rows: [] })).toContain('No records for this diagram')
  })
})
