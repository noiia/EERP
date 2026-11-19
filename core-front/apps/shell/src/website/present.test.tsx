import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('@/website/site-preferences', () => ({
  getSitePreferences: async () => ({
    prefs: { locale: 'fr', currency: 'EUR' },
    localization: { default_locale: 'fr', default_currency: 'EUR', base: 'EUR', rates: {}, currencies: ['EUR'], date_format: '' },
    locales: ['fr'],
  }),
}))

import type { ViewDescriptor } from '@eerp/core-front'
import { moduleRegistry } from '@eerp/core-front/server'
import { FieldLines } from './blocks/FieldValue'
import { presentFields } from './present'
import type { PublicDataSource } from './types'

const plain = (s: string | null | undefined) => s?.replace(/\s/g, ' ')
const source = (rows: Record<string, Record<string, unknown>>): PublicDataSource => ({
  list: async () => null,
  get: async (table, id) => rows[`${table}:${id}`] ?? null,
})
// A table no module describes: kinds come from column names and values.
const record = { id: 'r1', name: 'Chair', phone: '0612345678', unit_price: 1250, email: 'shop@x.io', notes: '' }

async function present(displays?: unknown, fields = ['phone', 'unit_price', 'email', 'notes']) {
  return presentFields({ table: 'demo_table', fields, records: [record], displays, source: source({}) })
}

describe('presentFields', () => {
  it('formats every field by its kind with no settings at all (blocks saved before field settings)', async () => {
    const p = await present(undefined)
    expect(p.columns.map((c) => [c.name, c.label, c.icon])).toEqual([['phone', 'Phone', null], ['unit_price', 'Unit price', null], ['email', 'Email', null], ['notes', 'Notes', null]])
    expect(p.values.r1.phone).toMatchObject({ text: '06 12 34 56 78', href: 'tel:+33612345678' })
    expect(plain(p.values.r1.unit_price?.text)).toBe('1 250,00 €')
    expect(p.values.r1.email).toEqual({ text: 'shop@x.io', href: 'mailto:shop@x.io' })
    expect(p.values.r1.notes).toBeNull() // empty: the line is left out
  })

  it('applies the label settings and a forced format', async () => {
    const p = await present({ phone: { custom_label: 'Contact us' }, email: { hide_label: true }, unit_price: { format: { as: 'decimal', decimals: 0 } } })
    expect(p.columns[0]).toMatchObject({ label: 'Contact us', spoken: 'Contact us' })
    expect(p.columns[2]).toMatchObject({ label: null, spoken: 'Email' })
    expect(plain(p.values.r1.unit_price?.text)).toBe('1 250')
  })

  it('resolves the icon once per column, and drops an unknown one', async () => {
    const p = await present({ phone: { icon: { name: 'phone', position: 'after' } }, email: { icon: { name: 'no-such-icon' } } })
    expect(p.columns[0].icon).toMatchObject({ name: 'phone', position: 'after', data: { family: 'solid', name: 'phone' } })
    expect(p.columns[2].icon).toBeNull()
  })

  it('leaves the records untouched', async () => {
    const before = JSON.stringify(record)
    await present({ phone: { format: { country: 'US' } } })
    expect(JSON.stringify(record)).toBe(before)
  })

  it('shows a linked record by its label, never its id; nothing when unpublished', async () => {
    // invoice.customer_id as the sale module declares it: a many2one to contact (label: name).
    // Declared here rather than read from the generated module manifest, which is empty
    // wherever no eerp-config.json is reachable (the CI's frontend job).
    const spy = vi.spyOn(moduleRegistry, 'formDescriptorFor').mockImplementation((table: string) => (table === 'invoice'
      ? { fields: [{ name: 'customer_id', label: 'Customer', type: 'relation', relation: { kind: 'many2one', entity: 'contact', labelField: 'name' } }] } as unknown as ViewDescriptor
      : null))
    const rows = [{ id: 'a', customer_id: 'c1' }, { id: 'b', customer_id: 'c2' }, { id: 'c', customer_id: 'c1' }]
    const get = vi.fn(async (table: string, id: string) => (table === 'contact' && id === 'c1' ? { id: 'c1', name: 'Ada' } : null))
    const p = await presentFields({ table: 'invoice', fields: ['customer_id'], records: rows, source: { list: async () => null, get } })
    expect(p.values.a.customer_id).toEqual({ text: 'Ada' })
    expect(p.values.c.customer_id).toEqual({ text: 'Ada' })
    expect(p.values.b.customer_id).toBeNull() // c2 isn't published
    expect(get).toHaveBeenCalledTimes(2) // one lookup per distinct id
    spy.mockRestore()
  })

  it('shows nothing for a forced relation it can’t resolve (no declared target)', async () => {
    const p = await presentFields({ table: 'demo', fields: ['customer_id'], records: [{ id: 'a', customer_id: 'c1' }], source: source({}),
      displays: { customer_id: { format: { as: 'relation' } } } })
    expect(p.values.a.customer_id).toBeNull()
  })
})

describe('FieldLines (rendering)', () => {
  it('draws the icon before or after the value, decorative, and links actionable values', async () => {
    const p = await present({ phone: { icon: { name: 'phone' } }, email: { icon: { name: 'envelope', family: 'regular', position: 'after' } } })
    const { container } = render(<div><FieldLines columns={p.columns} values={p.values.r1} /></div>)
    const call = screen.getByRole('link', { name: '06 12 34 56 78' })
    expect(call.getAttribute('href')).toBe('tel:+33612345678')
    // Icon first inside the phone link, last inside the mail link; never announced.
    expect(call.firstElementChild?.getAttribute('data-icon')).toBe('solid:phone')
    const mail = screen.getByRole('link', { name: 'shop@x.io' })
    expect(mail.lastElementChild?.getAttribute('data-icon')).toBe('regular:envelope')
    for (const svg of container.querySelectorAll('svg')) expect(svg.getAttribute('aria-hidden')).toBe('true')
  })

  it('keeps a hidden label in the accessible text, but not on screen', async () => {
    const p = await present({ phone: { hide_label: true } }, ['phone'])
    render(<div><FieldLines columns={p.columns} values={p.values.r1} /></div>)
    const line = document.querySelector('[data-field="phone"]')!
    expect(line.textContent).toBe('Phone: 06 12 34 56 78') // what a screen reader gets
    const hidden = [...line.querySelectorAll('span')].find((s) => s.textContent === 'Phone: ')
    expect(hidden && getComputedStyle(hidden).position).toBe('absolute') // visually hidden
  })

  it('shows no line at all for a field with nothing to show', async () => {
    const p = await present(undefined, ['notes'])
    const { container } = render(<div><FieldLines columns={p.columns} values={p.values.r1} /></div>)
    expect(container.textContent).toBe('')
  })
})
