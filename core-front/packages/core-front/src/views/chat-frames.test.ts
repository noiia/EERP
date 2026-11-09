import { describe, expect, it, vi } from 'vitest'
import { handleChatFrame, onChatFrame } from './chat-frames'

describe('chat frames', () => {
  it('delivers chat frames until unsubscribed, ignores others', () => {
    const fn = vi.fn()
    const off = onChatFrame(fn)
    expect(handleChatFrame({ type: 'chat_message' })).toBe(true)
    expect(handleChatFrame({ type: 'update' })).toBe(false)
    expect(fn).toHaveBeenCalledTimes(1)
    off()
    expect(handleChatFrame({ type: 'chat_reaction' })).toBe(true)
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
