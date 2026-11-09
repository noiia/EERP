import { create } from 'zustand'
import { listMessages, markRead, type Message, type Reaction } from './client'

// Live chat state keyed by channel id (team channels and direct conversations
// alike). Messages are kept oldest-first; Go pages them newest-first.

const PAGE = 50

export interface ChatMessageFrame {
  type: 'chat_message'
  channel_id: string
  team_id?: string | null
  message: Message
}
export interface ChatReactionFrame {
  type: 'chat_reaction'
  channel_id: string
  message_id: string
  /** Frames carry no `mine` (it's per viewer); a toggle response does. */
  reactions: { emoji: string; count: number; mine?: boolean }[]
}

interface ChatState {
  /** The channel on screen: its incoming messages don't count as unread. */
  open: string | null
  messages: Record<string, Message[]>
  hasMore: Record<string, boolean>
  unread: Record<string, number>
  setUnread: (counts: Record<string, number>) => void
  load: (channel: string) => Promise<void>
  loadOlder: (channel: string) => Promise<void>
  close: (channel: string) => void
  receive: (frame: ChatMessageFrame) => void
  applyReactions: (frame: ChatReactionFrame) => void
}

const merge = (a: Message[], b: Message[]) => {
  const seen = new Set(a.map((m) => m.id))
  return [...a, ...b.filter((m) => !seen.has(m.id))]
}

export const useChatStore = create<ChatState>((set, get) => ({
  open: null,
  messages: {},
  hasMore: {},
  unread: {},
  setUnread: (counts) => {
    const open = get().open
    set({ unread: { ...get().unread, ...counts, ...(open ? { [open]: 0 } : {}) } })
  },
  load: async (channel) => {
    set({ open: channel, unread: { ...get().unread, [channel]: 0 } })
    void markRead(channel).catch(() => {})
    const page = (await listMessages(channel, undefined, PAGE)).reverse()
    // Frames that arrived while the page was loading are kept.
    set({
      messages: { ...get().messages, [channel]: merge(page, get().messages[channel] ?? []) },
      hasMore: { ...get().hasMore, [channel]: page.length === PAGE },
    })
  },
  loadOlder: async (channel) => {
    const current = get().messages[channel] ?? []
    if (!get().hasMore[channel] || current.length === 0) return
    const page = (await listMessages(channel, current[0].created_at, PAGE)).reverse()
    set({
      messages: { ...get().messages, [channel]: merge(page, get().messages[channel] ?? []) },
      hasMore: { ...get().hasMore, [channel]: page.length === PAGE },
    })
  },
  close: (channel) => {
    if (get().open === channel) set({ open: null })
  },
  receive: ({ channel_id: channel, message }) => {
    const s = get()
    const list = s.messages[channel]
    if (list?.some((m) => m.id === message.id)) return
    const isOpen = s.open === channel
    if (isOpen) void markRead(channel).catch(() => {})
    set({
      // A channel never loaded keeps no partial history: load() fetches it whole.
      messages: list ? { ...s.messages, [channel]: [...list, message] } : s.messages,
      unread: isOpen ? s.unread : { ...s.unread, [channel]: (s.unread[channel] ?? 0) + 1 },
    })
  },
  applyReactions: ({ channel_id: channel, message_id, reactions }) => {
    const list = get().messages[channel]
    if (!list) return
    set({
      messages: {
        ...get().messages,
        [channel]: list.map((m) => {
          if (m.id !== message_id) return m
          const mine = new Map(m.reactions.map((r) => [r.emoji, r.mine]))
          return { ...m, reactions: reactions.map((r): Reaction => ({ emoji: r.emoji, count: r.count, mine: r.mine ?? mine.get(r.emoji) ?? false })) }
        }),
      },
    })
  },
}))
