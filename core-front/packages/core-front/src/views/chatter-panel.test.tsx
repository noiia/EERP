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

  it('renders a message as "author : body"', async () => {
    const messages: ChatterMessageRecord[] = [
      { id: 'm1', author: 'alice@x.com', kind: 'message', body: 'Looks good', createdAt: '2026-01-01T00:00:00Z' },
    ]
    const ops = { list: vi.fn(async () => messages), create: vi.fn() }
    render(
      <ChatterOpsProvider ops={ops}>
        <ChatterPanel entity="crm" recordId="1" />
      </ChatterOpsProvider>,
    )
    expect(await screen.findByText('alice@x.com')).toBeInTheDocument()
    expect(screen.getByText('Looks good')).toBeInTheDocument()
  })

  it('renders a log entry\'s changed fields as "author - field : old" / icon / "new", one line per field', async () => {
    const messages: ChatterMessageRecord[] = [
      {
        id: 'm2',
        author: 'bob@x.com',
        kind: 'log',
        body: 'Status : open → won\nAmount : 10 → 20',
        createdAt: '2026-01-02T00:00:00Z',
      },
    ]
    const ops = { list: vi.fn(async () => messages), create: vi.fn() }
    const { container } = render(
      <ChatterOpsProvider ops={ops}>
        <ChatterPanel entity="crm" recordId="1" />
      </ChatterOpsProvider>,
    )
    await waitFor(() => expect(ops.list).toHaveBeenCalledWith('crm', '1'))
    expect(await screen.findByText('bob@x.com - Status : open')).toBeInTheDocument()
    expect(screen.getByText('won')).toBeInTheDocument()
    expect(screen.getByText('bob@x.com - Amount : 10')).toBeInTheDocument()
    expect(screen.getByText('20')).toBeInTheDocument()
    // The arrow glyph is never rendered as raw text — only as an icon.
    expect(screen.queryByText(/→/)).not.toBeInTheDocument()
    expect(container.querySelectorAll('svg').length).toBeGreaterThanOrEqual(2)
  })

  it('falls back to plain "author - line" for a log line with no arrow', async () => {
    const messages: ChatterMessageRecord[] = [
      { id: 'm3', author: 'bob@x.com', kind: 'log', body: 'legacy note', createdAt: '2026-01-02T00:00:00Z' },
    ]
    const ops = { list: vi.fn(async () => messages), create: vi.fn() }
    render(
      <ChatterOpsProvider ops={ops}>
        <ChatterPanel entity="crm" recordId="1" />
      </ChatterOpsProvider>,
    )
    expect(await screen.findByText('bob@x.com - legacy note')).toBeInTheDocument()
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

  it('Ctrl+Enter in the composer sends the message', async () => {
    const created: ChatterMessageRecord = {
      id: 'm4',
      author: 'me@x.com',
      kind: 'message',
      body: 'Quick note',
      createdAt: '2026-01-04T00:00:00Z',
    }
    const ops = { list: vi.fn(async () => []), create: vi.fn(async () => created) }
    render(
      <ChatterOpsProvider ops={ops}>
        <ChatterPanel entity="crm" recordId="1" />
      </ChatterOpsProvider>,
    )
    await waitFor(() => expect(ops.list).toHaveBeenCalled())

    const composer = screen.getByPlaceholderText('Write a message…')
    fireEvent.change(composer, { target: { value: 'Quick note' } })
    fireEvent.keyDown(composer, { key: 'Enter', ctrlKey: true })

    await waitFor(() => expect(ops.create).toHaveBeenCalledWith('crm', '1', 'message', 'Quick note'))
    expect(await screen.findByText('Quick note')).toBeInTheDocument()
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
