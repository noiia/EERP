import { describe, expect, it } from 'vitest'
import { validateReportDescriptor, type ReportDescriptor } from './report-descriptor'

const valid: ReportDescriptor = {
  name: 'crm.statement',
  entity: 'crm',
  permissions: ['crm:crm:read'],
  layout: [
    {
      kind: 'section',
      className: 'p-4',
      children: [
        { kind: 'field', name: 'name' },
        { kind: 'field', name: 'created_at', format: 'date' },
      ],
    },
    {
      kind: 'table',
      source: 'line_items',
      columns: [
        { name: 'description', label: 'Description' },
        { name: 'total', label: 'Total' },
      ],
    },
    { kind: 'pageBreak' },
  ],
}

describe('validateReportDescriptor', () => {
  it('accepts a well-formed descriptor, including nested sections', () => {
    expect(() => validateReportDescriptor(valid)).not.toThrow()
  })

  it('rejects a field node with a missing name', () => {
    const bad: ReportDescriptor = {
      ...valid,
      layout: [{ kind: 'field', name: '' }],
    }
    expect(() => validateReportDescriptor(bad)).toThrowError(/"field" node requires a name/)
  })

  it('rejects a table node with no source', () => {
    const bad: ReportDescriptor = {
      ...valid,
      layout: [{ kind: 'table', source: '', columns: [{ name: 'x', label: 'X' }] }],
    }
    expect(() => validateReportDescriptor(bad)).toThrowError(/"table" node requires a source/)
  })

  it('rejects a table node with no columns', () => {
    const bad: ReportDescriptor = {
      ...valid,
      layout: [{ kind: 'table', source: 'line_items', columns: [] }],
    }
    expect(() => validateReportDescriptor(bad)).toThrowError(/requires at least one column/)
  })

  it('rejects a table column with no name', () => {
    const bad: ReportDescriptor = {
      ...valid,
      layout: [{ kind: 'table', source: 'line_items', columns: [{ name: '', label: 'X' }] }],
    }
    expect(() => validateReportDescriptor(bad)).toThrowError(/has a column with no name/)
  })

  it('validates field nodes nested inside a section', () => {
    const bad: ReportDescriptor = {
      ...valid,
      layout: [{ kind: 'section', children: [{ kind: 'field', name: '' }] }],
    }
    expect(() => validateReportDescriptor(bad)).toThrowError(/"field" node requires a name/)
  })

  it('accepts a bare pageBreak with no other content', () => {
    const bare: ReportDescriptor = { ...valid, layout: [{ kind: 'pageBreak' }] }
    expect(() => validateReportDescriptor(bare)).not.toThrow()
  })
})
