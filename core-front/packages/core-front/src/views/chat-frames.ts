// Live Teams chat frames (chat_message / chat_reaction / chat_message_deleted) pushed over the presence
// socket (internal/teams): not stored here, just fanned out to whichever chat
// view is mounted.

export interface ChatFrame {
  type: 'chat_message' | 'chat_reaction' | 'chat_message_deleted'
  channel_id: string
  [key: string]: unknown
}

const subscribers = new Set<(frame: ChatFrame) => void>()

/** Subscribe to chat frames; returns the unsubscribe function. */
export function onChatFrame(fn: (frame: ChatFrame) => void): () => void {
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}

/** Fans one frame out; true when it was a chat frame (handled or not). */
export function handleChatFrame(msg: { type?: string }): boolean {
  if (msg.type !== 'chat_message' && msg.type !== 'chat_reaction' && msg.type !== 'chat_message_deleted') return false
  for (const fn of subscribers) fn(msg as ChatFrame)
  return true
}
