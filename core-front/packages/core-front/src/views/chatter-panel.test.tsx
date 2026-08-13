import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ChatterOpsProvider, type ChatterMessageRecord } from './chatter-ops'
import { ChatterPanel } from './chatter-panel'
import { useUiStore } from './ui-store'

beforeEach(() => {
  useUiStore.setState({ chatterWidth: 360 })
})

describe('ChatterPanel', () => {
  it('renders nothing with no ChatterOpsProvider mounted', () => {
    const { container } = render(<ChatterPanel entity="crm" recordId="1" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the unsaved-record hint instead of the composer when there is no record id yet', () => {
    const ops = { list: vi.fn(), create: vi.fn() }
    render(
      <ChatterOpsProvider ops={ops}>
        <ChatterPanel entity="crm" recordId={null} />
      </ChatterOpsProvider>,
    )
    expect(screen.getByText('Available once the record has been saved.')).toBeInTheDocument()
    expect(ops.list).not.toHaveBeenCalled()
  })

  it('lists messages newest-first as "author : body", styling a log entry distinctly from a message', async () => {
    const messages: ChatterMessageRecord[] = [
      { id: 'm2', author: 'bob@x.com', kind: 'log', body: 'Changed status: open → won', createdAt: '2026-01-02T00:00:00Z' },
      { id: 'm1', author: 'alice@x.com', kind: 'message', body: 'Looks good', createdAt: '2026-01-01T00:00:00Z' },
    ]
    const ops = { list: vi.fn(async () => messages), create: vi.fn() }
    render(
      <ChatterOpsProvider ops={ops}>
        <ChatterPanel entity="crm" recordId="1" />
      </ChatterOpsProvider>,
    )
    await waitFor(() => expect(ops.list).toHaveBeenCalledWith('crm', '1'))
    expect(await screen.findByText('bob@x.com')).toBeInTheDocument()
    expect(screen.getByText('Changed status: open → won')).toBeInTheDocument()
    expect(screen.getByText('alice@x.com')).toBeInTheDocument()
    expect(screen.getByText('Looks good')).toBeInTheDocument()
  })

  it('posting a message calls create and prepends it to the feed', async () => {
    const created: ChatterMessageRecord = {
      id: 'm3',
      author: 'me@x.com',
      kind: 'message',
      body: 'New comment',
      createdAt: '2026-01-03T00:00:00Z',
    }
    const ops = { list: vi.fn(async () => []), create: vi.fn(async () => created) }
    render(
      <ChatterOpsProvider ops={ops}>
        <ChatterPanel entity="crm" recordId="1" />
      </ChatterOpsProvider>,
    )
    await waitFor(() => expect(ops.list).toHaveBeenCalled())

    fireEvent.change(screen.getByPlaceholderText('Write a message…'), { target: { value: 'New comment' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(ops.create).toHaveBeenCalledWith('crm', '1', 'message', 'New comment'))
    expect(await screen.findByText('New comment')).toBeInTheDocument()
    // The composer clears after a successful post.
    expect(screen.getByPlaceholderText('Write a message…')).toHaveValue('')
  })

  it('the Send button stays disabled for a blank draft', async () => {
    const ops = { list: vi.fn(async () => []), create: vi.fn() }
    render(
      <ChatterOpsProvider ops={ops}>
        <ChatterPanel entity="crm" recordId="1" />
      </ChatterOpsProvider>,
    )
    await waitFor(() => expect(ops.list).toHaveBeenCalled())
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  })
})
