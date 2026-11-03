import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { Block } from '@/website/types'
import type { WfNode, WfPage } from '@/website/workflow'
import { NewLinkDialog, RemoveLinkDialog } from './WorkflowDialogs'

const hero: Block = { id: 'h1', type: 'hero', x: 0, y: 0, w: 36, h: 10, config: { title: 'Welcome' } }
const list: Block = { id: 'l1', type: 'record_list', x: 0, y: 10, w: 36, h: 10, config: {} }
const page: WfPage = { id: 'p1', slug: 'home2', title: 'Home 2', published: true, in_menu: true, layout: [hero, list] }
const pages: WfPage[] = [page, { id: 'p2', slug: 'booking', title: 'Booking', published: true, in_menu: false, layout: [] }]
const login: WfNode = { id: 'sys:login', label: 'Login' }
const booking: WfNode = { id: 'page:booking', label: 'Booking', slug: 'booking', pageId: 'p2' }

describe('NewLinkDialog', () => {
  it('lists the free blocks, hinting each by its title, and saves the picked one', async () => {
    const onSave = vi.fn(async () => {})
    render(<NewLinkDialog page={page} to={booking} pages={pages} onCancel={vi.fn()} onSave={onSave} />)
    expect(screen.getByRole('radio', { name: 'Hero “Welcome” — Button' })).toBeChecked()
    // A list's detail page holds no button: no text asked.
    fireEvent.click(screen.getByRole('radio', { name: 'Record list — Card detail page' }))
    expect(screen.queryByLabelText(/Button text/)).toBeNull()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Add link' })))
    expect(onSave).toHaveBeenCalledWith({ slot: { blockId: 'l1', key: 'detail_slug' }, to: 'page:booking', label: undefined, next: undefined })
  })

  it('a link to Login asks its button text and the page to go to after login', async () => {
    const onSave = vi.fn(async () => {})
    render(<NewLinkDialog page={page} to={login} pages={pages} onCancel={vi.fn()} onSave={onSave} />)
    const text = screen.getByLabelText(/Button text/)
    expect(text).toHaveValue('Login')
    fireEvent.change(text, { target: { value: '' } })
    expect(screen.getByRole('button', { name: 'Add link' })).toBeDisabled()
    fireEvent.change(text, { target: { value: 'Reserve' } })
    fireEvent.mouseDown(screen.getByLabelText('After login, go to'))
    // Home can't be an after-login target (an empty slug means My account).
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['My account', 'Home 2', 'Booking'])
    fireEvent.click(screen.getByRole('option', { name: 'Booking' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Add a new button block at the bottom of the page' }))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Add link' })))
    expect(onSave).toHaveBeenCalledWith({ slot: 'new', to: 'sys:login', label: 'Reserve', next: 'booking' })
  })

  it('cancels', () => {
    const onCancel = vi.fn()
    render(<NewLinkDialog page={page} to={booking} pages={pages} onCancel={onCancel} onSave={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalled()
  })
})

describe('RemoveLinkDialog', () => {
  it('names the link and confirms or cancels', async () => {
    const onConfirm = vi.fn(async () => {})
    const onCancel = vi.fn()
    render(<RemoveLinkDialog label="Go" pageTitle="Home" onCancel={onCancel} onConfirm={onConfirm} />)
    expect(screen.getByText('Go')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalled()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Remove' })))
    expect(onConfirm).toHaveBeenCalled()
  })
})
