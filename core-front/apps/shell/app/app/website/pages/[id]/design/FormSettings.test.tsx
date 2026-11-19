import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const targets = [
  { table: 'contact', columns: ['address_city', 'address_complement', 'address_country', 'address_number', 'address_state', 'address_street', 'address_zip_code', 'company', 'email', 'name', 'phone', 'surname'] },
  { table: 'crm', columns: ['company', 'contact_id', 'name', 'notes', 'phone', 'status'] },
]
vi.mock('@/website/editor-actions', () => ({
  listFormTargets: async () => targets,
  listEditorPages: async () => [{ slug: 'thanks', title: 'Thanks', published: true }],
}))

import { FormSettings } from './FormSettings'
import type { FormConfig } from '@/website/types'

/** Holds the config like BlockSettings does, and records every change. */
function Harness({ initial, spy }: { initial: FormConfig; spy?: (c: FormConfig) => void }) {
  const [config, setConfig] = useState(initial)
  return <FormSettings blockId="b1" config={config} onChange={(c) => { spy?.(c); setConfig(c) }} />
}

const base = (patch: Partial<FormConfig> = {}): FormConfig => ({ targets: [{ table: 'contact' }], fields: [], after: { kind: 'message', message: '' }, ...patch })

describe('FormSettings', () => {
  it('the User data preset adds name, surname, email and phone on the contact target', async () => {
    const spy = vi.fn()
    render(<Harness initial={base()} spy={spy} />)
    fireEvent.click(await screen.findByRole('button', { name: /user data/i }))
    const next = spy.mock.calls.at(-1)![0] as FormConfig
    expect(next.fields.map((f) => [f.column, f.type, f.target, !!f.required])).toEqual([
      ['name', 'text', 0, true], ['surname', 'text', 0, false], ['email', 'email', 0, true], ['phone', 'phone', 0, false],
    ])
    // Twice: nothing mapped twice (Go refuses a column mapped more than once).
    fireEvent.click(screen.getByRole('button', { name: /user data/i }))
    expect((spy.mock.calls.at(-1)![0] as FormConfig).fields).toHaveLength(4)
  })

  it('the Message preset needs a crm target', async () => {
    render(<Harness initial={base()} />)
    expect((await screen.findByRole('button', { name: /message/i })).hasAttribute('disabled')).toBe(true)
  })

  it("a field's column select lists only its target's registered columns, ids excluded", async () => {
    render(<Harness initial={base({
      targets: [{ table: 'contact' }, { table: 'crm', links: { contact_id: 0 } }],
      fields: [{ id: 'f1', label: 'Question', type: 'text', column: '', target: 1 }],
    })} />)
    const row = await screen.findByTestId('form-field-0')
    fireEvent.mouseDown(within(row).getByLabelText('Column'))
    await waitFor(() => expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['company', 'name', 'notes', 'phone', 'status']))
  })

  it('target tables come from the registry; an _id column offers the earlier targets', async () => {
    render(<Harness initial={base({ targets: [{ table: 'contact' }, { table: 'crm' }] })} />)
    fireEvent.mouseDown(within(await screen.findByTestId('form-target-1')).getByLabelText('Table'))
    await waitFor(() => expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['contact', 'crm']))
    fireEvent.click(screen.getByRole('option', { name: 'crm' }))
    fireEvent.mouseDown(screen.getByLabelText('contact_id'))
    const listbox = screen.getByRole('listbox')
    expect(within(listbox).getAllByRole('option').map((o) => o.textContent)).toEqual(['Not linked', '← record of target 1 (contact)'])
  })

  it('account creation is hidden when login is required', async () => {
    render(<Harness initial={base()} />)
    expect(await screen.findByLabelText(/allow account creation/i)).toBeTruthy()
    fireEvent.click(screen.getByLabelText(/login required/i))
    expect(screen.queryByLabelText(/allow account creation/i)).toBeNull()
    expect(screen.getByLabelText(/after login, go to/i)).toBeTruthy()
  })

  it('edits a field: label, type, column, required, options, then removes it', async () => {
    const spy = vi.fn()
    render(<Harness initial={base()} spy={spy} />)
    const last = () => spy.mock.calls.at(-1)![0] as FormConfig
    fireEvent.click(await screen.findByRole('button', { name: 'Add field' }))
    expect(last().fields).toEqual([{ id: expect.any(String), label: '', type: 'text', column: '', target: 0 }])
    const row = screen.getByTestId('form-field-0')
    fireEvent.change(within(row).getByLabelText('Label'), { target: { value: 'City' } })
    expect(last().fields[0].label).toBe('City')
    fireEvent.mouseDown(within(row).getByLabelText('Column'))
    fireEvent.click(await screen.findByRole('option', { name: 'email' }))
    expect(last().fields[0].column).toBe('email')
    fireEvent.click(within(row).getByLabelText('Required'))
    expect(last().fields[0].required).toBe(true)
    // An address column is a prefix: switching to address clears the column.
    fireEvent.mouseDown(within(row).getByLabelText('Type'))
    fireEvent.click(screen.getByRole('option', { name: 'Address' }))
    expect(last().fields[0]).toMatchObject({ type: 'address', column: '' })
    fireEvent.mouseDown(within(row).getByLabelText('Type'))
    fireEvent.click(screen.getByRole('option', { name: 'Selection' }))
    const options = within(screen.getByTestId('form-field-0')).getByLabelText('Options (one per line)')
    fireEvent.change(options, { target: { value: ' Yes \n\nNo' } })
    fireEvent.blur(options)
    expect(last().fields[0].options).toEqual(['Yes', 'No'])
    fireEvent.click(within(screen.getByTestId('form-field-0')).getByRole('button', { name: 'Remove field' }))
    expect(last().fields).toEqual([])
  })

  it('adds, links, fixes values on and removes a target', async () => {
    const spy = vi.fn()
    render(<Harness initial={base({ fields: [{ id: 'f1', label: 'Q', type: 'text', column: 'name', target: 0 }] })} spy={spy} />)
    const last = () => spy.mock.calls.at(-1)![0] as FormConfig
    fireEvent.click(await screen.findByRole('button', { name: 'Add target' }))
    expect(last().targets).toEqual([{ table: 'contact' }, { table: 'contact' }])
    // Moving the field to the new target clears its column.
    fireEvent.mouseDown(within(screen.getByTestId('form-field-0')).getByLabelText('Stored in'))
    fireEvent.click(screen.getByRole('option', { name: /Target 2/ }))
    expect(last().fields[0]).toMatchObject({ target: 1, column: '' })
    const second = () => screen.getByTestId('form-target-1')
    fireEvent.mouseDown(within(second()).getByLabelText('Table'))
    fireEvent.click(screen.getByRole('option', { name: 'crm' }))
    fireEvent.mouseDown(within(second()).getByLabelText('contact_id'))
    fireEvent.click(screen.getByRole('option', { name: /record of target 1/ }))
    expect(last().targets[1].links).toEqual({ contact_id: 0 })
    fireEvent.mouseDown(within(second()).getByLabelText('contact_id'))
    fireEvent.click(screen.getByRole('option', { name: 'Not linked' }))
    expect(last().targets[1].links).toEqual({})
    fireEvent.click(within(second()).getByRole('button', { name: 'Add fixed value' }))
    expect(Object.keys(last().targets[1].fixed ?? {})).toHaveLength(1)
    fireEvent.change(within(second()).getByLabelText('Fixed value'), { target: { value: 'lead' } })
    expect(Object.values(last().targets[1].fixed ?? {})).toEqual(['lead'])
    fireEvent.mouseDown(within(second()).getAllByLabelText('Column')[0])
    fireEvent.click(screen.getByRole('option', { name: 'status' }))
    expect(last().targets[1].fixed).toEqual({ status: 'lead' })
    fireEvent.click(within(second()).getByRole('button', { name: 'Remove fixed value' }))
    expect(last().targets[1].fixed).toEqual({})
    fireEvent.click(within(second()).getByRole('button', { name: 'Remove target 2' }))
    expect(last().targets).toEqual([{ table: 'contact' }])
  })

  it('sets the button label, the after-submit message or page, and the login options', async () => {
    const spy = vi.fn()
    render(<Harness initial={base()} spy={spy} />)
    const last = () => spy.mock.calls.at(-1)![0] as FormConfig
    fireEvent.change(await screen.findByLabelText('Button label'), { target: { value: 'Join' } })
    expect(last().submit_label).toBe('Join')
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Thanks!' } })
    expect(last().after).toEqual({ kind: 'message', message: 'Thanks!' })
    fireEvent.mouseDown(screen.getByLabelText('Then'))
    fireEvent.click(screen.getByRole('option', { name: 'Go to a page' }))
    fireEvent.mouseDown(screen.getByLabelText('Page'))
    fireEvent.click(await screen.findByRole('option', { name: /Thanks \(\/thanks\)/ }))
    expect(last().after).toMatchObject({ kind: 'page', slug: 'thanks' })
    fireEvent.click(screen.getByLabelText('Allow account creation'))
    expect(last().allow_signup).toBe(true)
    fireEvent.click(screen.getByLabelText('Login required'))
    fireEvent.mouseDown(screen.getByLabelText('After login, go to'))
    fireEvent.click(screen.getByRole('option', { name: /Thanks \(\/thanks\)/ }))
    expect(last()).toMatchObject({ login_required: true, after_login_slug: 'thanks' })
  })
})
