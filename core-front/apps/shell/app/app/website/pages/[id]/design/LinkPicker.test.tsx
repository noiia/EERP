import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('@/website/editor-actions', () => ({
  listEditorPages: async () => [{ slug: 'about', title: 'About', published: true }, { slug: 'book', title: 'Book', published: true }],
}))

import { LinkPicker } from './LinkPicker'

type V = { href?: string; next?: string }
function Harness({ initial, spy }: { initial: V; spy?: (v: V) => void }) {
  const [v, setV] = useState(initial)
  return <LinkPicker id="x" label="Link" href={v.href ?? ''} next={v.next ?? ''} onChange={(h, n) => { spy?.({ href: h, next: n }); setV({ href: h, next: n }) }} />
}
const pick = async (name: RegExp) => {
  fireEvent.mouseDown(screen.getByRole('combobox', { name: /^link/i }))
  fireEvent.click(await screen.findByRole('option', { name }))
}

describe('LinkPicker', () => {
  it('shows the kind inferred from the stored href', async () => {
    render(<Harness initial={{ href: '/login', next: 'book' }} />)
    await waitFor(() => expect(screen.getByRole('combobox', { name: /after login/i }).textContent).toMatch(/Book/))
    expect(screen.getByRole('combobox', { name: /^link/i }).textContent).toBe('Login')
  })

  it('round-trips each kind', async () => {
    const spy = vi.fn()
    render(<Harness initial={{}} spy={spy} />)
    await pick(/^Login$/)
    expect(spy).toHaveBeenLastCalledWith({ href: '/login', next: '' })
    await pick(/^Sign up$/)
    expect(spy).toHaveBeenLastCalledWith({ href: '/signup', next: '' })
    await pick(/^My account$/)
    expect(spy).toHaveBeenLastCalledWith({ href: '/account', next: '' })
    await pick(/^External link$/)
    fireEvent.change(screen.getByRole('textbox', { name: /url/i }), { target: { value: 'https://x.io' } })
    expect(spy).toHaveBeenLastCalledWith({ href: 'https://x.io', next: '' })
    await pick(/^Site page$/)
    fireEvent.mouseDown(screen.getByRole('combobox', { name: /^page/i }))
    fireEvent.click(await screen.findByRole('option', { name: /about/i }))
    expect(spy).toHaveBeenLastCalledWith({ href: '/about', next: '' })
  })

  it('Login reveals the after-login page and stores its slug', async () => {
    const spy = vi.fn()
    render(<Harness initial={{ href: '/login' }} spy={spy} />)
    fireEvent.mouseDown(await screen.findByRole('combobox', { name: /after login/i }))
    fireEvent.click(await screen.findByRole('option', { name: /book/i }))
    expect(spy).toHaveBeenLastCalledWith({ href: '/login', next: 'book' })
  })

  it('flags an external link that is not safe', async () => {
    render(<Harness initial={{ href: 'javascript:x' }} />)
    expect(screen.getByText(/not a valid link/i)).toBeTruthy()
  })
})
