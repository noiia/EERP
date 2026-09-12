import { describe, expect, it } from 'vitest'
import {
  reportCompanyFallbackFields,
  reportImageSources,
  reportMastheadSection,
  reportTableRelations,
  reportTitleSection,
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

describe('reportMastheadSection', () => {
  const masthead = reportMastheadSection({ companyPrefix: 'issuer', contactPrefix: 'customer' })

  it('is a well-formed descriptor node on its own', () => {
    const descriptor: ReportDescriptor = { ...valid, layout: [masthead] }
    expect(() => validateReportDescriptor(descriptor)).not.toThrow()
  })

  it('renders company (left) and contact (right) as the parties row', () => {
    expect(masthead).toMatchObject({ kind: 'section', className: 'eerp-report-parties' })
    expect(masthead.children).toHaveLength(2)
    expect(masthead.children[0]).toMatchObject({ className: 'eerp-report-issuer' })
    expect(masthead.children[1]).toMatchObject({ className: 'eerp-report-client' })
  })

  it('falls back every company-side address field to the active company profile, except the address number', () => {
    // address_number is deliberately excluded: company[companyField] ?? ''
    // can't distinguish "blank" from a legitimate 0 the way it can for the
    // string fields (see reportPartyAddressFields' own doc comment).
    const descriptor: ReportDescriptor = { ...valid, layout: [masthead] }
    expect(reportCompanyFallbackFields(descriptor)).toEqual([
      { recordField: 'issuer_name', companyField: 'name' },
      { recordField: 'issuer_address_street', companyField: 'address_street' },
      { recordField: 'issuer_address_complement', companyField: 'address_complement' },
      { recordField: 'issuer_address_zip_code', companyField: 'address_zip_code' },
      { recordField: 'issuer_address_city', companyField: 'address_city' },
      { recordField: 'issuer_address_country', companyField: 'address_country' },
    ])
  })

  it('never gives the contact side a company fallback — it prints only its own fields', () => {
    const contactFieldNames = (masthead.children[1] as { children: { name?: string }[] }).children
      .flatMap((n) => ('children' in n ? (n as { children: { name: string }[] }).children : [n]))
      .map((n) => n.name)
    expect(contactFieldNames).toEqual([
      'customer_name',
      'customer_address_number',
      'customer_address_street',
      'customer_address_complement',
      'customer_address_zip_code',
      'customer_address_city',
      'customer_address_country',
    ])
  })
})

describe('reportTitleSection', () => {
  it('renders the named field with the big-title class', () => {
    expect(reportTitleSection('title')).toEqual({
      kind: 'field',
      name: 'title',
      className: 'eerp-report-title',
    })
  })
})
