import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const listMessages = vi.fn()
const toggleReaction = vi.fn()
const postMessage = vi.fn()
const deleteMessage = vi.fn()
vi.mock('./client', () => ({
  listMessages: (...a: unknown[]) => listMessages(...a),
  markRead: () => Promise.resolve(),
  postMessage: (...a: unknown[]) => postMessage(...a),
  deleteMessage: (...a: unknown[]) => deleteMessage(...a),
  toggleReaction: (...a: unknown[]) => toggleReaction(...a),
}))

import { ChatPane } from './ChatPane'
import { useChatStore } from './chat-store'
import { useSessionStore } from '@eerp/core-front'

const msg = (id: string, created_at: string, over: object = {}) => ({
  id, channel_id: 'c1', author_id: 'u1', author_name: 'Alice', body: `body ${id}`, created_at, attachments: [], reactions: [], ...over,
})

describe('ChatPane', () => {
  beforeEach(() => {
    useChatStore.setState({ open: null, messages: {}, hasMore: {}, unread: {} })
    toggleReaction.mockReset().mockResolvedValue({ reactions: [{ emoji: '👍', count: 2, mine: true }] })
    listMessages.mockReset().mockResolvedValue([
      msg('m2', '2026-01-02T10:00:00Z', {
        reactions: [{ emoji: '👍', count: 1, mine: false }],
        attachments: [{ id: 'att1', filename: 'plan.pdf', mime: 'application/pdf', size: 10 }],
      }),
      msg('m1', '2026-01-01T10:00:00Z'),
    ])
  })

  const renderPane = () => render(<ChatPane channelId="c1" title="general" members={[]} canAttach readOnly={false} />)

  it('renders messages oldest at the top', async () => {
    renderPane()
    const items = await screen.findAllByRole('article')
    expect(items.map((i) => within(i).getByText(/^body/).textContent)).toEqual(['body m1', 'body m2'])
  })

  it('shows the author photo when the author has one', async () => {
    listMessages.mockResolvedValue([msg('m1', '2026-01-01T10:00:00Z', { author_has_avatar: true })])
    const { container } = renderPane()
    await screen.findByRole('article')
    expect(container.querySelector('img')).toHaveAttribute('src', '/api/avatars/u1')
  })

  it('links attachments to the BFF download route', async () => {
    renderPane()
    expect(await screen.findByRole('link', { name: /plan\.pdf/ })).toHaveAttribute('href', '/api/teams/attachments/att1')
  })

  it('clicking a reaction chip toggles it', async () => {
    renderPane()
    fireEvent.click(await screen.findByRole('button', { name: /👍 1/ }))
    await waitFor(() => expect(toggleReaction).toHaveBeenCalledWith('m2', '👍'))
    expect(await screen.findByRole('button', { name: /👍 2/ })).toBeInTheDocument()
  })

  it('reacts from the emoji popover', async () => {
    renderPane()
    fireEvent.click((await screen.findAllByRole('button', { name: /add reaction/i }))[0])
    fireEvent.click(await screen.findByRole('button', { name: '🎉' }))
    await waitFor(() => expect(toggleReaction).toHaveBeenCalledWith('m1', '🎉'))
  })

  it('sends a message and appends it', async () => {
    postMessage.mockResolvedValue(msg('m3', '2026-01-03T10:00:00Z'))
    renderPane()
    await screen.findAllByRole('article')
    fireEvent.change(screen.getByRole('textbox', { name: /message/i }), { target: { value: 'hello' } })
    fireEvent.keyDown(screen.getByRole('textbox', { name: /message/i }), { key: 'Enter' })
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith('c1', 'hello', [], []))
    expect(await screen.findByText('body m3')).toBeInTheDocument()
  })

  it('puts dropped files in the composer and sends them only on Send', async () => {
    postMessage.mockResolvedValue(msg('m3', '2026-01-03T10:00:00Z'))
    const onFolderChanged = vi.fn()
    render(<ChatPane channelId="c1" title="general" members={[]} canAttach readOnly={false} teamId="t1" onFolderChanged={onFolderChanged} />)
    await screen.findAllByRole('article')
    const file = new File(['x'], 'drop.png', { type: 'image/png' })
    fireEvent.drop(screen.getByTestId('teams-chat-pane'), { dataTransfer: { files: [file], types: ['Files'] } })
    expect(await screen.findByText('drop.png')).toBeInTheDocument()
    expect(postMessage).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith('c1', '', [], [file]))
    await waitFor(() => expect(onFolderChanged).toHaveBeenCalled())
  })

  it('offers Delete on own messages only, and removes a deleted one', async () => {
    useSessionStore.setState({ identity: { userId: 'u1' } } as never)
    listMessages.mockResolvedValue([msg('m2', '2026-01-02T10:00:00Z', { author_id: 'u2' }), msg('m1', '2026-01-01T10:00:00Z')])
    deleteMessage.mockReset().mockResolvedValue(undefined)
    renderPane()
    await screen.findAllByRole('article')
    expect(screen.getAllByRole('button', { name: 'Message options' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Message options' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete message' }))
    await waitFor(() => expect(deleteMessage).toHaveBeenCalledWith('m1'))
    await waitFor(() => expect(screen.queryByText('body m1')).toBeNull())
    expect(screen.getByText('body m2')).toBeInTheDocument()
  })

  it('lets a team owner delete anyone\'s message and shows a refusal', async () => {
    useSessionStore.setState({ identity: { userId: 'u9' } } as never)
    deleteMessage.mockReset().mockRejectedValue(new Error('Your role does not allow this.'))
    render(<ChatPane channelId="c1" title="general" members={[]} canAttach readOnly={false} teamId="t1" role="owner" />)
    await screen.findAllByRole('article')
    expect(screen.getAllByRole('button', { name: 'Message options' })).toHaveLength(2)
    fireEvent.click(screen.getAllByRole('button', { name: 'Message options' })[0])
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete message' }))
    expect(await screen.findByText('Your role does not allow this.')).toBeInTheDocument()
    expect(screen.getByText('body m1')).toBeInTheDocument()
  })

  it('has a Folder toggle in a team channel only', async () => {
    const { unmount } = render(<ChatPane channelId="c1" title="general" members={[]} canAttach readOnly={false} teamId="t1" role="member" folderId={null} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Folder' }))
    expect(await screen.findByText('No folder yet. Files sent here will create one.')).toBeInTheDocument()
    unmount()
    renderPane()
    await screen.findAllByRole('article')
    expect(screen.queryByRole('button', { name: 'Folder' })).toBeNull()
  })

  it('loads older messages when scrolled to the top', async () => {
    listMessages.mockResolvedValueOnce(Array.from({ length: 50 }, (_, i) => msg(`n${i}`, `2026-02-01T00:00:${String(59 - i).padStart(2, '0')}Z`)))
    renderPane()
    await screen.findAllByRole('article')
    listMessages.mockResolvedValueOnce([msg('old', '2026-01-01T00:00:00Z')])
    fireEvent.scroll(screen.getAllByRole('article')[0].parentElement!, { target: { scrollTop: 0 } })
    expect(await screen.findByText('body old')).toBeInTheDocument()
  })
})
