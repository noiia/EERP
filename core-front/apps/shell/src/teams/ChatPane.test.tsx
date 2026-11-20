import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const listMessages = vi.fn()
const toggleReaction = vi.fn()
const postMessage = vi.fn()
const deleteMessage = vi.fn()
const editMessage = vi.fn()
vi.mock('./client', () => ({
  listMessages: (...a: unknown[]) => listMessages(...a),
  markRead: () => Promise.resolve(),
  postMessage: (...a: unknown[]) => postMessage(...a),
  deleteMessage: (...a: unknown[]) => deleteMessage(...a),
  editMessage: (...a: unknown[]) => editMessage(...a),
  toggleReaction: (...a: unknown[]) => toggleReaction(...a),
}))

import { ChatPane, stacksOnPrevious } from './ChatPane'
import type { Message } from './client'
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

  it('reacts from the hover toolbar, which holds the only reaction button of a message', async () => {
    renderPane()
    const first = (await screen.findAllByRole('article'))[0]
    const bar = within(first).getByRole('toolbar', { name: 'Message actions' })
    expect(within(first).getAllByRole('button', { name: /add reaction/i })).toHaveLength(1)
    expect(within(bar).getByRole('button', { name: /add reaction/i })).toBeInTheDocument()
    fireEvent.click(within(bar).getByRole('button', { name: 'React with 😂' }))
    await waitFor(() => expect(toggleReaction).toHaveBeenCalledWith('m1', '😂'))
  })

  it('sends a message and appends it', async () => {
    postMessage.mockResolvedValue(msg('m3', '2026-01-03T10:00:00Z'))
    renderPane()
    await screen.findAllByRole('article')
    fireEvent.change(screen.getByRole('textbox', { name: /message/i }), { target: { value: 'hello' } })
    fireEvent.keyDown(screen.getByRole('textbox', { name: /message/i }), { key: 'Enter' })
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith('c1', 'hello', [], [], undefined))
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
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith('c1', '', [], [file], undefined))
    await waitFor(() => expect(onFolderChanged).toHaveBeenCalled())
  })

  it('stacks a run of one author\'s messages under a single author line', async () => {
    useSessionStore.setState({ identity: { userId: 'u1' } } as never)
    // Newest first, as Go pages them.
    listMessages.mockResolvedValue([
      msg('m6', '2026-01-01T23:59:00Z'), // 5h59 after m5: stacked
      msg('m5', '2026-01-01T18:00:00Z'), // 6h50 after m4: new author line
      msg('m4', '2026-01-01T11:10:00Z'), // Alice again after Bob: new author line
      msg('m3', '2026-01-01T11:00:00Z', { author_id: 'u2', author_name: 'Bob' }),
      msg('m2', '2026-01-01T10:30:00Z'), // stacked under m1
      msg('m1', '2026-01-01T10:00:00Z'),
    ])
    renderPane()
    const items = await screen.findAllByRole('article')
    const headed = items.map((i) => within(i).queryByText(/^(Alice|Bob)$/) !== null)
    expect(headed).toEqual([true, false, true, true, true, false])
    expect(items.map((i) => i.hasAttribute('data-stacked'))).toEqual(headed.map((h) => !h))
    // A stacked message keeps its options (delete) and its time, on hover.
    expect(within(items[1]).getByRole('button', { name: 'Message options' })).toBeInTheDocument()
    expect(items[1]).toHaveAttribute('title', new Date('2026-01-01T10:30:00Z').toLocaleString())
    expect(screen.getAllByText('Alice')).toHaveLength(3)
  })

  it('stacks at most 6 hours apart, same author only', () => {
    const at = (iso: string, author = 'u1') => msg('x', iso, { author_id: author }) as unknown as Message
    expect(stacksOnPrevious(undefined, at('2026-01-01T10:00:00Z'))).toBe(false)
    expect(stacksOnPrevious(at('2026-01-01T10:00:00Z'), at('2026-01-01T16:00:00Z'))).toBe(true)
    expect(stacksOnPrevious(at('2026-01-01T10:00:00Z'), at('2026-01-01T16:00:01Z'))).toBe(false)
    expect(stacksOnPrevious(at('2026-01-01T10:00:00Z', 'u2'), at('2026-01-01T10:01:00Z'))).toBe(false)
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

  it('lets the author modify a message in place (Modify above Delete), others only delete', async () => {
    useSessionStore.setState({ identity: { userId: 'u1' } } as never)
    listMessages.mockResolvedValue([msg('m2', '2026-01-02T10:00:00Z', { author_id: 'u2', author_name: 'Bob' }), msg('m1', '2026-01-01T10:00:00Z')])
    editMessage.mockReset().mockImplementation(async (id: string, body: string) => msg(id, '2026-01-01T10:00:00Z', { body, edited_at: '2026-01-03T10:00:00Z' }))
    render(<ChatPane channelId="c1" title="general" members={[]} canAttach readOnly={false} teamId="t1" role="owner" />)
    const items = await screen.findAllByRole('article')
    // Bob's message: an owner may delete it, never rewrite it.
    fireEvent.click(within(items[1]).getByRole('button', { name: 'Message options' }))
    expect((await screen.findAllByRole('menuitem')).map((i) => i.textContent)).toEqual(['Delete message'])
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    // Mine: Modify first, then Delete.
    fireEvent.click(within(items[0]).getByRole('button', { name: 'Message options' }))
    expect((await screen.findAllByRole('menuitem')).map((i) => i.textContent)).toEqual(['Modify message', 'Delete message'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Modify message' }))
    const box = await screen.findByRole('textbox', { name: 'Message to modify' })
    expect(box).toHaveValue('body m1')
    // Escape gives the message back untouched.
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(screen.queryByRole('textbox', { name: 'Message to modify' })).toBeNull()
    expect(screen.getByText('body m1')).toBeInTheDocument()
    fireEvent.click(within(screen.getAllByRole('article')[0]).getByRole('button', { name: 'Message options' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Modify message' }))
    fireEvent.change(await screen.findByRole('textbox', { name: 'Message to modify' }), { target: { value: 'body m1, fixed' } })
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message to modify' }), { key: 'Enter', ctrlKey: true })
    await waitFor(() => expect(editMessage).toHaveBeenCalledWith('m1', 'body m1, fixed'))
    expect(await screen.findByText('body m1, fixed')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Message to modify' })).toBeNull()
    expect(within(screen.getAllByRole('article')[0]).getByText('(edited)')).toBeInTheDocument()
  })

  it('keeps the draft in the editor when the edit is refused', async () => {
    useSessionStore.setState({ identity: { userId: 'u1' } } as never)
    listMessages.mockResolvedValue([msg('m1', '2026-01-01T10:00:00Z')])
    editMessage.mockReset().mockRejectedValue(new Error('A message needs a body or a file.'))
    renderPane()
    fireEvent.click(await screen.findByRole('button', { name: 'Message options' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Modify message' }))
    fireEvent.change(await screen.findByRole('textbox', { name: 'Message to modify' }), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('A message needs a body or a file.')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Message to modify' })).toHaveValue('')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByText('body m1')).toBeInTheDocument()
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

  it('replies to a message: quoted in the composer, sent with reply_to, shown above the reply', async () => {
    postMessage.mockResolvedValue(msg('m3', '2026-01-03T10:00:00Z', { reply_to: { id: 'm1', author_name: 'Alice', body: 'body m1', deleted: false } }))
    renderPane()
    const first = (await screen.findAllByRole('article'))[0]
    fireEvent.click(within(first).getByRole('button', { name: 'Reply' }))
    expect(screen.getByText(/Replying to/)).toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: /message/i }), { target: { value: 'yes' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith('c1', 'yes', [], [], 'm1'))
    await waitFor(() => expect(screen.queryByText(/Replying to/)).toBeNull())
    const reply = (await screen.findAllByRole('article'))[2]
    expect(within(reply).getByRole('button', { name: 'Go to the answered message' })).toHaveTextContent('Alice body m1')
  })

  it('cancels a reply with Escape and quotes a deleted message as such', async () => {
    listMessages.mockResolvedValue([msg('m2', '2026-01-02T10:00:00Z', { reply_to: { id: 'gone', author_name: '', body: '', deleted: true } })])
    renderPane()
    const item = await screen.findByRole('article')
    expect(within(item).getByRole('button', { name: 'Go to the answered message' })).toHaveTextContent('Deleted message')
    fireEvent.click(within(item).getByRole('button', { name: 'Reply' }))
    fireEvent.keyDown(screen.getByRole('textbox', { name: /message/i }), { key: 'Escape' })
    expect(screen.queryByText(/Replying to/)).toBeNull()
  })
})
