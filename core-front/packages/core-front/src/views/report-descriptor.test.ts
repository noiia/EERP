import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REPORT_NAME,
  defaultReport,
  reportAddressBlock,
  reportCompanyFallbackFields,
  reportImageSources,
  reportMastheadSection,
  reportPartyAddressFields,
  reportTableRelations,
  reportTitleSection,
  resolveReports,
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

  it('falls back every company-side address field to the active company profile', () => {
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
      'customer_address_street',
      'customer_address_complement',
      'customer_address_zip_code',
      'customer_address_city',
      'customer_address_country',
    ])
  })
})

describe('reportPartyAddressFields', () => {
  it('never prints the address-number sub-column as its own line — only the street', () => {
    const fields = reportPartyAddressFields('issuer', false)
    expect(fields.map((n) => ('name' in n ? n.name : n.kind))).not.toContain('issuer_address_number')
    expect(fields[1]).toEqual({ kind: 'field', name: 'issuer_address_street', companyFallback: undefined })
  })

  it('puts zip/city on a row, country on its own line after', () => {
    const fields = reportPartyAddressFields('issuer', false)
    const lastRow = fields[fields.length - 1]
    expect(lastRow).toEqual({ kind: 'field', name: 'issuer_address_country', companyFallback: undefined })
  })

  it('gates the complement behind a "set" display condition, so a blank one prints no line', () => {
    const fields = reportPartyAddressFields('issuer', false)
    const complement = fields[2] as { name?: string; display?: unknown }
    expect(complement).toMatchObject({
      name: 'issuer_address_complement',
      display: { field: 'issuer_address_complement', op: 'set' },
    })
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

describe('report inheritance (resolveReports)', () => {
  const base: ReportDescriptor = {
    name: 'base',
    abstract: true,
    entity: '',
    permissions: [],
    chrome: { header: true, footer: true },
    pageFormat: 'a4',
    layout: [{ kind: 'text', text: 'Top' }, { kind: 'slot' }, { kind: 'text', text: 'Bottom' }],
  }
  const child: ReportDescriptor = {
    name: 'child',
    extends: 'base',
    entity: 'crm',
    permissions: [],
    layout: [{ kind: 'field', name: 'name' }],
  }

  it("puts the child's layout in the parent's slot and inherits chrome and page format", () => {
    const got = resolveReports([base, child]).get('child')!
    expect(got.layout).toEqual([
      { kind: 'text', text: 'Top' },
      { kind: 'field', name: 'name' },
      { kind: 'text', text: 'Bottom' },
    ])
    expect(got.chrome).toEqual({ header: true, footer: true })
    expect(got.pageFormat).toBe('a4')
    expect(got.abstract).toBeUndefined() // never inherited: the child is printable
  })

  it('a slot inside a section is filled too', () => {
    const nested: ReportDescriptor = { ...base, layout: [{ kind: 'section', className: 'wrap', children: [{ kind: 'slot' }] }] }
    expect(resolveReports([nested, child]).get('child')!.layout).toEqual([
      { kind: 'section', className: 'wrap', children: [{ kind: 'field', name: 'name' }] },
    ])
  })

  it("without a slot the child's layout is appended; the child's own chrome and page format win", () => {
    const noSlot: ReportDescriptor = { ...base, layout: [{ kind: 'text', text: 'Top' }] }
    const own: ReportDescriptor = { ...child, chrome: { footer: false }, pageFormat: 'letter' }
    const got = resolveReports([noSlot, own]).get('child')!
    expect(got.layout).toEqual([{ kind: 'text', text: 'Top' }, { kind: 'field', name: 'name' }])
    expect(got.chrome).toEqual({ header: true, footer: false })
    expect(got.pageFormat).toBe('letter')
  })

  it('chains: a grandchild gets every ancestor', () => {
    const middle: ReportDescriptor = { ...child, name: 'middle', abstract: true, layout: [{ kind: 'text', text: 'Mid' }, { kind: 'slot' }] }
    const leaf: ReportDescriptor = { ...child, name: 'leaf', extends: 'middle' }
    expect(resolveReports([leaf, middle, base]).get('leaf')!.layout).toEqual([
      { kind: 'text', text: 'Top' },
      { kind: 'text', text: 'Mid' },
      { kind: 'field', name: 'name' },
      { kind: 'text', text: 'Bottom' },
    ])
  })

  it('a report that extends nothing gets no letterhead', () => {
    expect(resolveReports([{ ...child, extends: undefined }]).get('child')!.chrome).toBeUndefined()
  })

  it('names a cycle and an unknown parent', () => {
    const a: ReportDescriptor = { ...child, name: 'a', extends: 'b' }
    const b: ReportDescriptor = { ...child, name: 'b', extends: 'a' }
    expect(() => resolveReports([a, b])).toThrowError(/cycle: a -> b -> a/)
    expect(() => resolveReports([{ ...child, extends: 'missing' }])).toThrowError(/"child" extends unknown report "missing"/)
  })

  it('the default report is the letterhead header and footer around a slot', () => {
    expect(defaultReport).toMatchObject({ name: DEFAULT_REPORT_NAME, abstract: true, chrome: { header: true, footer: true } })
    expect(defaultReport.layout).toEqual([{ kind: 'slot' }])
  })

  it('validation: a printable report needs an entity, a report cannot extend itself', () => {
    expect(() => validateReportDescriptor({ ...child, entity: '' })).toThrowError(/requires an entity/)
    expect(() => validateReportDescriptor({ ...child, extends: 'child' })).toThrowError(/cannot extend itself/)
    expect(() => validateReportDescriptor(base)).not.toThrow()
  })
})

describe('reportAddressBlock', () => {
  it('is a labeled, left-aligned block of lines', () => {
    expect(reportAddressBlock('Customer:', [{ kind: 'field', name: 'customer_name' }], 'extra')).toEqual({
      kind: 'section',
      className: 'eerp-report-address extra',
      children: [
        { kind: 'text', text: 'Customer:', className: 'eerp-report-label' },
        { kind: 'field', name: 'customer_name' },
      ],
    })
  })
})
