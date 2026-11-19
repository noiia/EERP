import { describe, expect, it } from 'vitest'
import { addPreset, addressPrefixes, fieldColumns, newFieldId, removeTarget, typeableColumns, usedColumns } from './form-config'
import type { FormConfig } from './types'

const cfg = (patch: Partial<FormConfig> = {}): FormConfig => ({ targets: [{ table: 'contact' }], fields: [], after: { kind: 'message' }, ...patch })

describe('form-config', () => {
  it('an address field writes its 7 prefixed columns', () => {
    expect(fieldColumns({ type: 'address', column: 'home' })).toEqual(['home_number', 'home_complement', 'home_street', 'home_zip_code', 'home_city', 'home_state', 'home_country'])
    expect(fieldColumns({ type: 'text', column: 'name' })).toEqual(['name'])
  })

  it('offers only complete address prefixes, and never id columns to type into', () => {
    const cols = [...fieldColumns({ type: 'address', column: 'address' }), 'work_street', 'name', 'contact_id']
    expect(addressPrefixes(cols)).toEqual(['address'])
    expect(typeableColumns(cols)).not.toContain('contact_id')
  })

  it('the message preset needs a crm target and maps onto its notes', () => {
    expect(addPreset(cfg(), 'message')).toBeNull()
    const next = addPreset(cfg({ targets: [{ table: 'contact' }, { table: 'crm' }] }), 'message')!
    expect(next.fields).toEqual([{ id: 'message', label: 'Message', type: 'long', column: 'notes', target: 1, preset: 'message' }])
  })

  it('a preset skips columns already written and keeps ids unique', () => {
    const c = cfg({ targets: [{ table: 'contact', fixed: { phone: '0' } }], fields: [{ id: 'name', label: 'X', type: 'text', column: 'company', target: 0 }] })
    const next = addPreset(c, 'user')!
    expect(next.fields.map((f) => `${f.id}:${f.column}`)).toEqual(['name:company', 'name_2:name', 'surname:surname', 'email:email'])
    expect([...usedColumns(next, 0)].sort()).toEqual(['company', 'email', 'name', 'phone', 'surname'])
    expect(newFieldId(cfg({ fields: [{ id: 'field_1', label: '', type: 'text', column: '', target: 0 }] }))).toBe('field_2')
  })

  it('removing a target drops its fields and links, and shifts later indexes', () => {
    const c = cfg({
      targets: [{ table: 'contact' }, { table: 'crm', links: { contact_id: 0 } }, { table: 'x', links: { a_id: 0, b_id: 1 } }],
      fields: [{ id: 'a', label: '', type: 'text', column: 'name', target: 0 }, { id: 'b', label: '', type: 'text', column: 'n', target: 2 }],
    })
    const next = removeTarget(c, 0)
    expect(next.targets).toEqual([{ table: 'crm', links: {} }, { table: 'x', links: { b_id: 0 } }])
    expect(next.fields).toEqual([{ id: 'b', label: '', type: 'text', column: 'n', target: 1 }])
  })
})
