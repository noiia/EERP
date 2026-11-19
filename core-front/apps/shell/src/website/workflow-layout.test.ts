import { describe, expect, it } from 'vitest'
import type { WfEdge, WfNode, WfProblem } from './workflow'
import { layoutWorkflow, problemLevels } from './workflow-layout'

const node = (id: WfNode['id'], extra: Partial<WfNode> = {}): WfNode => ({ id, label: id, ...extra })
const edge = (from: WfEdge['from'], to: WfEdge['to']): WfEdge => ({ id: `${from}>${to}`, from, to, label: '', pageId: 'p', blockId: 'b', key: 'cta_href' })

describe('layoutWorkflow', () => {
  it('places nodes in columns by BFS depth from the home page, rows by visit order, unreachable last', () => {
    const nodes = [node('page:about'), node('page:'), node('sys:login'), node('page:orphan'), node('page:contact')]
    const edges = [edge('page:', 'page:about'), edge('page:', 'sys:login'), edge('sys:login', 'page:contact')]
    expect(layoutWorkflow(nodes, edges)).toEqual({
      'page:': { col: 0, row: 0 },
      'page:about': { col: 1, row: 0 },
      'sys:login': { col: 1, row: 1 },
      'page:contact': { col: 2, row: 0 },
      'page:orphan': { col: 3, row: 0 },
    })
  })

  it('starts from the menu pages when there is no home page', () => {
    const nodes = [node('page:a'), node('page:b', { inMenu: true }), node('page:c')]
    expect(layoutWorkflow(nodes, [edge('page:b', 'page:c')])).toEqual({
      'page:b': { col: 0, row: 0 },
      'page:c': { col: 1, row: 0 },
      'page:a': { col: 2, row: 0 },
    })
  })

  it('puts everything in one column when nothing is a root', () => {
    expect(layoutWorkflow([node('page:a'), node('page:b')], [])).toEqual({
      'page:a': { col: 0, row: 0 },
      'page:b': { col: 0, row: 1 },
    })
  })
})

describe('problemLevels', () => {
  it('maps problems to their edge or node, errors winning over warnings, missing nodes in error', () => {
    const problems: WfProblem[] = [
      { level: 'warning', message: 'w', nodeId: 'page:x' },
      { level: 'warning', message: 'w', nodeId: 'page:y', edgeId: 'e1' },
      { level: 'error', message: 'e', nodeId: 'page:y', edgeId: 'e1' },
    ]
    const { nodes, edges } = problemLevels([node('page:x'), node('page:z', { missing: true })], problems)
    expect(nodes.get('page:x')).toBe('warning')
    expect(nodes.get('page:z')).toBe('error')
    expect(nodes.has('page:y')).toBe(false)
    expect(edges.get('e1')).toBe('error')
  })
})
