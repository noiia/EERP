import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), prefetch: vi.fn() }) }))
const listDirect = vi.fn()
const listMessages = vi.fn()
vi.mock('./client', () => ({
  getTeam: () => Promise.resolve({ id: 't1', name: 'Sales', description: '', role: 'guest', member_count: 1, unread: 0 }),
  listMembers: () => Promise.resolve([{ user_id: 'u1', display_name: 'Alice', email: 'a@x', role: 'owner' }]),
  listChannels: () => Promise.resolve([
    { id: 'c1', team_id: 't1', kind: 'channel', name: 'general', unread: 0 },
    { id: 'c2', team_id: 't1', kind: 'channel', name: 'random', unread: 1 },
  ]),
  listDirect: () => listDirect(),
  listShared: () => Promise.reject(Object.assign(new Error(''), { status: 404 })),
  listFiles: () => Promise.reject(Object.assign(new Error(''), { status: 404 })),
  listMessages: (...a: unknown[]) => listMessages(...a),
  markRead: () => Promise.resolve(),
  directory: () => Promise.resolve([]),
}))

import { handleChatFrame, notifyLiveReconnect, useRecordLabelStore } from '@eerp/core-front'
import { TeamsWorkspace } from './TeamsWorkspace'
import { useChatStore } from './chat-store'

const message = (id: string, channel_id: string) => ({
  id, channel_id, author_id: 'u1', author_name: 'Alice', body: 'hey', created_at: '2026-01-01T00:00:00Z', attachments: [], reactions: [],
})

describe('TeamsWorkspace', () => {
  beforeEach(() => {
    useChatStore.setState({ open: null, messages: {}, hasMore: {}, unread: {} })
    listDirect.mockReset().mockResolvedValue([])
    listMessages.mockReset().mockResolvedValue([])
  })

  it('re-reads the sidebar and the open channel when the live socket reconnects', async () => {
    render(<TeamsWorkspace teamId="t1" view={{ kind: 'channel', id: 'c1' }} />)
    await screen.findByRole('heading', { name: '# general' })
    await waitFor(() => expect(listMessages).toHaveBeenCalledTimes(1))
    const directs = listDirect.mock.calls.length
    listMessages.mockResolvedValueOnce([message('m9', 'c1')])
    act(() => notifyLiveReconnect())
    await waitFor(() => expect(listDirect).toHaveBeenCalledTimes(directs + 1))
    await waitFor(() => expect(listMessages).toHaveBeenCalledTimes(2))
    expect(listMessages).toHaveBeenLastCalledWith('c1', undefined, 50)
    expect(await screen.findByText('hey')).toBeInTheDocument()
  })

  it('names the breadcrumb after the team and channel, not their ids', async () => {
    const { unmount } = render(<TeamsWorkspace teamId="t1" view={{ kind: 'channel', id: 'c1' }} />)
    await waitFor(() => expect(useRecordLabelStore.getState()).toMatchObject({ id: 'c1', label: 'Sales / # general' }))
    unmount()
    expect(useRecordLabelStore.getState().label).toBeNull()
  })

  it('names a direct conversation after the other person', async () => {
    listDirect.mockResolvedValue([{ id: 'd1', other_user: { id: 'u2', display_name: 'Bob', email: 'b@x' }, unread: 0, last_message_at: null }])
    render(<TeamsWorkspace view={{ kind: 'direct', id: 'd1' }} />)
    await waitFor(() => expect(useRecordLabelStore.getState()).toMatchObject({ id: 'd1', label: 'Bob' }))
  })

  it('names the files page after the team', async () => {
    render(<TeamsWorkspace teamId="t1" view={{ kind: 'files' }} />)
    await waitFor(() => expect(useRecordLabelStore.getState()).toMatchObject({ id: 'files', label: 'Sales / Files' }))
  })

  it('opens the channel read-only for a guest, without attachments', async () => {
    render(<TeamsWorkspace teamId="t1" view={{ kind: 'channel', id: 'c1' }} />)
    expect(await screen.findByRole('heading', { name: '# general' })).toBeInTheDocument()
    expect(await screen.findByText(/read only/i)).toBeInTheDocument()
  })

  it('counts live messages of other channels and refreshes directs on a new conversation', async () => {
    render(<TeamsWorkspace teamId="t1" view={{ kind: 'channel', id: 'c1' }} />)
    await screen.findByRole('link', { name: /random/ })
    act(() => {
      handleChatFrame({ type: 'chat_message', channel_id: 'c2', team_id: 't1', message: message('m1', 'c2') } as never)
    })
    await waitFor(() => expect(screen.getByRole('link', { name: /random/ })).toHaveTextContent('2'))
    expect(listDirect).toHaveBeenCalledTimes(1)
    act(() => {
      handleChatFrame({ type: 'chat_message', channel_id: 'd9', team_id: null, message: message('m2', 'd9') } as never)
    })
    await waitFor(() => expect(listDirect).toHaveBeenCalledTimes(2))
  })

  it('leaves a placeholder main pane for the files and shared views', async () => {
    const { rerender } = render(<TeamsWorkspace teamId="t1" view={{ kind: 'files' }} />)
    expect(screen.getByTestId('teams-files-pane')).toBeInTheDocument()
    rerender(<TeamsWorkspace view={{ kind: 'shared' }} />)
    expect(screen.getByTestId('teams-shared-pane')).toBeInTheDocument()
    await waitFor(() => expect(listDirect).toHaveBeenCalled())
  })

  it('shows an empty direct workspace', async () => {
    render(<TeamsWorkspace view={{ kind: 'direct' }} />)
    expect(screen.getByText(/start a conversation/i)).toBeInTheDocument()
    await waitFor(() => expect(listDirect).toHaveBeenCalled())
  })
})
