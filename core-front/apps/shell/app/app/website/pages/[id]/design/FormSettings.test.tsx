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
})
