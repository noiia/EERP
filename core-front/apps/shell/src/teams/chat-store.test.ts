import { beforeEach, describe, expect, it, vi } from 'vitest'

const listMessages = vi.fn()
const markRead = vi.fn()
vi.mock('./client', () => ({
  listMessages: (...a: unknown[]) => listMessages(...a),
  markRead: (...a: unknown[]) => markRead(...a),
}))

import { useChatStore } from './chat-store'

const msg = (id: string, created_at: string, over: object = {}) => ({
  id, channel_id: 'c1', author_id: 'u1', author_name: 'Alice', body: id, created_at, attachments: [], reactions: [], ...over,
})
const frame = (m: ReturnType<typeof msg>) => ({ type: 'chat_message' as const, channel_id: m.channel_id, team_id: 't1', message: m })

describe('chat-store', () => {
  beforeEach(() => {
    useChatStore.setState({ open: null, messages: {}, hasMore: {}, unread: {} })
    listMessages.mockReset()
    markRead.mockReset().mockResolvedValue(undefined)
  })

  it('load shows the newest page oldest-first, marks the channel read and zeroes its unread', async () => {
    useChatStore.getState().setUnread({ c1: 3 })
    listMessages.mockResolvedValue([msg('m2', '2026-01-02T00:00:00Z'), msg('m1', '2026-01-01T00:00:00Z')])
    await useChatStore.getState().load('c1')
    const s = useChatStore.getState()
    expect(s.messages.c1.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(s.hasMore.c1).toBe(false)
    expect(s.unread.c1).toBe(0)
    expect(markRead).toHaveBeenCalledWith('c1')
  })

  it('receive dedupes by id', async () => {
    listMessages.mockResolvedValue([msg('m1', '2026-01-01T00:00:00Z')])
    await useChatStore.getState().load('c1')
    useChatStore.getState().receive(frame(msg('m1', '2026-01-01T00:00:00Z')))
    useChatStore.getState().receive(frame(msg('m2', '2026-01-02T00:00:00Z')))
    useChatStore.getState().receive(frame(msg('m2', '2026-01-02T00:00:00Z')))
    expect(useChatStore.getState().messages.c1.map((m) => m.id)).toEqual(['m1', 'm2'])
  })

  it('unread increments only for channels that are not open', async () => {
    listMessages.mockResolvedValue([])
    await useChatStore.getState().load('c1')
    useChatStore.getState().receive(frame(msg('m1', '2026-01-01T00:00:00Z')))
    useChatStore.getState().receive(frame(msg('m2', '2026-01-01T00:00:00Z', { channel_id: 'c2' })))
    useChatStore.getState().receive(frame(msg('m3', '2026-01-01T00:00:00Z', { channel_id: 'c2' })))
    expect(useChatStore.getState().unread).toEqual({ c1: 0, c2: 2 })
  })

  it('loadOlder prepends the page before the oldest message', async () => {
    listMessages.mockResolvedValueOnce(Array.from({ length: 50 }, (_, i) => msg(`n${49 - i}`, `2026-02-01T00:00:${String(49 - i).padStart(2, '0')}Z`)))
    await useChatStore.getState().load('c1')
    expect(useChatStore.getState().hasMore.c1).toBe(true)
    listMessages.mockResolvedValueOnce([msg('o2', '2026-01-02T00:00:00Z'), msg('o1', '2026-01-01T00:00:00Z')])
    await useChatStore.getState().loadOlder('c1')
    expect(listMessages).toHaveBeenLastCalledWith('c1', '2026-02-01T00:00:00Z', 50)
    const ids = useChatStore.getState().messages.c1.map((m) => m.id)
    expect(ids.slice(0, 3)).toEqual(['o1', 'o2', 'n0'])
    expect(useChatStore.getState().hasMore.c1).toBe(false)
  })

  it('a reaction frame replaces counts while keeping mine', async () => {
    listMessages.mockResolvedValue([msg('m1', '2026-01-01T00:00:00Z', { reactions: [{ emoji: '👍', count: 1, mine: true }] })])
    await useChatStore.getState().load('c1')
    useChatStore.getState().applyReactions({
      type: 'chat_reaction', channel_id: 'c1', message_id: 'm1', reactions: [{ emoji: '👍', count: 2 }, { emoji: '🎉', count: 1 }],
    })
    expect(useChatStore.getState().messages.c1[0].reactions).toEqual([
      { emoji: '👍', count: 2, mine: true },
      { emoji: '🎉', count: 1, mine: false },
    ])
  })
})
