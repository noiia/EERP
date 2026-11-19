import { resolveWidget } from '@eerp/core-front'
import { describe, expect, it } from 'vitest'
import { companyFormDescriptor, companyListDescriptor } from './descriptors'

// The pages are thin RSC shells; the wiring worth guarding lives in these
// descriptors — entity/route pairing, row-click form path, writable fields.

describe('Settings → Company descriptors', () => {
  it('lists companies over the company entity and opens a form on row click', () => {
    expect(companyListDescriptor.entity).toBe('company')
    expect(companyListDescriptor.viewType).toBe('tree')
    expect(companyListDescriptor.formPath).toBe('/settings/company/:id')
  })

  it('gates Create on the write permission', () => {
    expect(companyListDescriptor.createPermission).toBe('company:company:write')
  })

  it('guards both views with the derived read permission', () => {
    expect(companyListDescriptor.permissions).toContain('company:company:read')
    expect(companyFormDescriptor.permissions).toContain('company:company:read')
  })

  it('requires a name; address/phone/email stay optional', () => {
    const required = companyFormDescriptor.fields.filter((f) => f.required).map((f) => f.name)
    expect(required).toEqual(['name'])
  })

  it('keeps the list compact (no address), the form carries every field', () => {
    expect(companyListDescriptor.fields.map((f) => f.name)).toEqual(['name', 'phone', 'email'])
    expect(companyFormDescriptor.fields.map((f) => f.name)).toEqual([
      'logo',
      'name',
      'address',
      'geo_location',
      'service_zone',
      'zone_contacts',
      'phone',
      'email',
      'currency',
    ])
  })

  it('locates the company, draws its service zone and lists the contacts inside it', () => {
    const field = (name: string) => companyFormDescriptor.fields.find((f) => f.name === name)!
    expect(field('geo_location')).toMatchObject({ type: 'geo', widget: 'point', widgetOptions: { address: 'address' } })
    expect(field('service_zone')).toMatchObject({ type: 'geo', widget: 'shape' })
    const zone = field('zone_contacts')
    expect(zone.readOnly).toBe(true)
    expect(zone.relation).toMatchObject({
      entity: 'contact',
      kind: 'one2many',
      inside: { field: 'geo_location', zone: 'service_zone' },
      formPath: '/contacts/:id',
    })
    for (const name of ['geo_location', 'service_zone', 'zone_contacts']) expect(() => resolveWidget(field(name))).not.toThrow()
  })

  it('the logo is the FIRST field — the default form anatomy places it top-left with no explicit layout', () => {
    const [first] = companyFormDescriptor.fields
    expect(first).toMatchObject({ name: 'logo', type: 'boolean', widget: 'picture' })
  })
})
