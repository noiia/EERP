import { describe, expect, it } from 'vitest'
import {
  reportCompanyFallbackFields,
  reportImageSources,
  reportTableRelations,
  validateReportDescriptor,
  type ReportDescriptor,
} from './report-descriptor'

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

  it('accepts a text node with content', () => {
    const ok: ReportDescriptor = { ...valid, layout: [{ kind: 'text', text: 'Total HT' }] }
    expect(() => validateReportDescriptor(ok)).not.toThrow()
  })

  it('rejects a text node with no text', () => {
    const bad: ReportDescriptor = { ...valid, layout: [{ kind: 'text', text: '' }] }
    expect(() => validateReportDescriptor(bad)).toThrowError(/"text" node requires text/)
  })

  it('accepts an image node with a source', () => {
    const ok: ReportDescriptor = { ...valid, layout: [{ kind: 'image', source: 'logo' }] }
    expect(() => validateReportDescriptor(ok)).not.toThrow()
  })

  it('rejects an image node with no source', () => {
    const bad: ReportDescriptor = { ...valid, layout: [{ kind: 'image', source: '' }] }
    expect(() => validateReportDescriptor(bad)).toThrowError(/"image" node requires a source/)
  })

  it('accepts a table node with a well-formed relation', () => {
    const ok: ReportDescriptor = {
      ...valid,
      layout: [
        {
          kind: 'table',
          source: 'lines',
          columns: [{ name: 'quantity', label: 'Quantity' }],
          relation: { entity: 'sale_line', inverseField: 'invoice_id' },
        },
      ],
    }
    expect(() => validateReportDescriptor(ok)).not.toThrow()
  })

  it('rejects a table relation missing entity or inverseField', () => {
    const bad: ReportDescriptor = {
      ...valid,
      layout: [
        {
          kind: 'table',
          source: 'lines',
          columns: [{ name: 'quantity', label: 'Quantity' }],
          relation: { entity: '', inverseField: 'invoice_id' },
        },
      ],
    }
    expect(() => validateReportDescriptor(bad)).toThrowError(/relation requires both entity and inverseField/)
  })
})

describe('reportImageSources', () => {
  it('is empty for a layout with no image nodes', () => {
    expect(reportImageSources(valid)).toEqual([])
  })

  it('collects an image node\'s source, including one nested in a section', () => {
    const descriptor: ReportDescriptor = {
      ...valid,
      layout: [
        { kind: 'image', source: 'logo' },
        { kind: 'section', children: [{ kind: 'image', source: 'signature' }] },
      ],
    }
    expect(reportImageSources(descriptor)).toEqual(['logo', 'signature'])
  })
})

describe('reportCompanyFallbackFields', () => {
  it('is empty for a layout with no companyFallback fields', () => {
    expect(reportCompanyFallbackFields(valid)).toEqual([])
  })

  it('collects a field\'s companyFallback pairing, including one nested in a section', () => {
    const descriptor: ReportDescriptor = {
      ...valid,
      layout: [
        { kind: 'field', name: 'issuer_name', companyFallback: 'name' },
        {
          kind: 'section',
          children: [{ kind: 'field', name: 'issuer_email', companyFallback: 'email' }],
        },
        { kind: 'field', name: 'subject' }, // no fallback — excluded
      ],
    }
    expect(reportCompanyFallbackFields(descriptor)).toEqual([
      { recordField: 'issuer_name', companyField: 'name' },
      { recordField: 'issuer_email', companyField: 'email' },
    ])
  })
})

describe('reportTableRelations', () => {
  it('is empty for a table node with no relation', () => {
    expect(reportTableRelations(valid)).toEqual([])
  })

  it('collects a table node\'s relation, including one nested in a section', () => {
    const descriptor: ReportDescriptor = {
      ...valid,
      layout: [
        {
          kind: 'table',
          source: 'lines',
          columns: [{ name: 'quantity', label: 'Quantity' }],
          relation: { entity: 'sale_line', inverseField: 'invoice_id' },
        },
        {
          kind: 'section',
          children: [
            {
              kind: 'table',
              source: 'items',
              columns: [{ name: 'name', label: 'Name' }],
              relation: { entity: 'other_line', inverseField: 'parent_id' },
            },
          ],
        },
      ],
    }
    expect(reportTableRelations(descriptor)).toEqual([
      { source: 'lines', entity: 'sale_line', inverseField: 'invoice_id' },
      { source: 'items', entity: 'other_line', inverseField: 'parent_id' },
    ])
  })
})
