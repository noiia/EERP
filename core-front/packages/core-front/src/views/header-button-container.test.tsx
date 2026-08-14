import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { HeaderButtonDescriptor } from './descriptor'
import { headerButtonRegistry, registerHeaderButtonAction, type HeaderButtonContext } from './header-button-actions'
import { HeaderButtonContainer } from './header-button-container'
import { RelationOpsProvider, type RelationOps } from './relation-ops'

afterEach(() => {
  headerButtonRegistry.clear()
})

const confirmButton: HeaderButtonDescriptor = {
  name: 'sale.confirmQuote',
  label: 'Confirm',
  states: { visible: { field: 'status', op: 'eq', value: 'draft' } },
}

const declineButton: HeaderButtonDescriptor = {
  name: 'sale.declineQuote',
  label: 'Decline',
  variant: 'secondary',
  states: { visible: { field: 'status', op: 'eq', value: 'sent' } },
}

describe('HeaderButtonContainer', () => {
  it('renders nothing with no headerButtons declared', () => {
    const { container } = render(
      <HeaderButtonContainer
        entity="quote"
        buttons={[]}
        recordId="r1"
        draft={{ status: 'draft' }}
        onFieldsCommit={vi.fn()}
      />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing on an unsaved (new) record even with buttons declared', () => {
    const { container } = render(
      <HeaderButtonContainer
        entity="quote"
        buttons={[confirmButton]}
        recordId="new"
        draft={{ status: 'draft' }}
        onFieldsCommit={vi.fn()}
      />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('only shows the button whose states.visible condition currently holds', () => {
    registerHeaderButtonAction({ entity: 'quote', name: 'sale.confirmQuote', handler: () => undefined })
    registerHeaderButtonAction({ entity: 'quote', name: 'sale.declineQuote', handler: () => undefined })
    render(
      <HeaderButtonContainer
        entity="quote"
        buttons={[confirmButton, declineButton]}
        recordId="r1"
        draft={{ status: 'draft' }}
        onFieldsCommit={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Decline' })).not.toBeInTheDocument()
  })

  it('renders a "secondary" button outlined and a default/primary one contained', () => {
    registerHeaderButtonAction({ entity: 'quote', name: 'sale.confirmQuote', handler: () => undefined })
    registerHeaderButtonAction({ entity: 'quote', name: 'sale.declineQuote', handler: () => undefined })
    render(
      <HeaderButtonContainer
        entity="quote"
        buttons={[confirmButton, declineButton]}
        recordId="r1"
        draft={{ status: 'sent' }}
        onFieldsCommit={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: 'Decline' }).className).toContain('outlined')
    expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument()
  })

  it('runs the registered handler with entity, recordId, draft, setFieldAndCommit and relationOps', async () => {
    let received: HeaderButtonContext | null = null
    registerHeaderButtonAction({
      entity: 'quote',
      name: 'sale.confirmQuote',
      handler: (ctx) => {
        received = ctx
      },
    })
    const ops: RelationOps = { list: vi.fn(), get: vi.fn(), create: vi.fn(), remove: vi.fn() }
    const onFieldsCommit = vi.fn(async () => ({ id: 'r1', status: 'confirmed' }))
    render(
      <RelationOpsProvider ops={ops}>
        <HeaderButtonContainer
          entity="quote"
          buttons={[confirmButton]}
          recordId="r1"
          draft={{ status: 'draft' }}
          onFieldsCommit={onFieldsCommit}
        />
      </RelationOpsProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))

    await waitFor(() => expect(received).not.toBeNull())
    expect(received).toMatchObject({ entity: 'quote', recordId: 'r1', draft: { status: 'draft' }, relationOps: ops })
    expect(typeof received!.setFieldAndCommit).toBe('function')
  })

  it('a handler calling setFieldAndCommit patches and commits via the passed-in callback', async () => {
    registerHeaderButtonAction({
      entity: 'quote',
      name: 'sale.confirmQuote',
      handler: async (ctx) => {
        await ctx.setFieldAndCommit({ status: 'confirmed' })
      },
    })
    const onFieldsCommit = vi.fn(async () => ({ id: 'r1', status: 'confirmed' }))
    render(
      <HeaderButtonContainer
        entity="quote"
        buttons={[confirmButton]}
        recordId="r1"
        draft={{ status: 'draft' }}
        onFieldsCommit={onFieldsCommit}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(onFieldsCommit).toHaveBeenCalledWith({ status: 'confirmed' }))
  })

  it('shows an inline error when the handler rejects', async () => {
    registerHeaderButtonAction({
      entity: 'quote',
      name: 'sale.confirmQuote',
      handler: () => Promise.reject(new Error('boom')),
    })
    render(
      <HeaderButtonContainer
        entity="quote"
        buttons={[confirmButton]}
        recordId="r1"
        draft={{ status: 'draft' }}
        onFieldsCommit={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(await screen.findByText('Action failed.')).toBeInTheDocument()
  })
})
