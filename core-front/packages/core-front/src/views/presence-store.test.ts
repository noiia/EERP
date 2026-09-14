import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  connectPresenceSocket,
  disconnectPresenceSocket,
  presenceStatusOf,
  usePresenceStore,
} from './presence-store'

class MockWebSocket {
  static instances: MockWebSocket[] = []
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  readyState = 0 // CONNECTING
  closed = false
  constructor(public url: string) {
    MockWebSocket.instances.push(this)
  }
  close() {
    this.closed = true
    this.readyState = 3
  }
}
// WebSocket.OPEN/CONNECTING constants connectPresenceSocket reads.
;(MockWebSocket as unknown as { OPEN: number; CONNECTING: number }).OPEN = 1
;(MockWebSocket as unknown as { OPEN: number; CONNECTING: number }).CONNECTING = 0

beforeEach(() => {
  usePresenceStore.setState({ statuses: {} })
  MockWebSocket.instances = []
  vi.stubGlobal('WebSocket', MockWebSocket)
  vi.useFakeTimers()
})

afterEach(() => {
  disconnectPresenceSocket()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('usePresenceStore', () => {
  it('setSnapshot replaces the whole map', () => {
    usePresenceStore.getState().setSnapshot([
      { user_id: 'u1', status: 'online' },
      { user_id: 'u2', status: 'busy' },
    ])
    expect(usePresenceStore.getState().statuses).toEqual({ u1: 'online', u2: 'busy' })
  })

  it('setOne updates a single user without touching the rest', () => {
    usePresenceStore.getState().setSnapshot([{ user_id: 'u1', status: 'online' }])
    usePresenceStore.getState().setOne('u2', 'absent')
    expect(usePresenceStore.getState().statuses).toEqual({ u1: 'online', u2: 'absent' })
  })

  it('presenceStatusOf defaults an unknown user to offline', () => {
    expect(presenceStatusOf('nobody')).toBe('offline')
  })
})

describe('connectPresenceSocket', () => {
  it('applies a snapshot message to the store', () => {
    connectPresenceSocket()
    const ws = MockWebSocket.instances[0]!
    ws.onmessage?.({
      data: JSON.stringify({ type: 'snapshot', users: [{ user_id: 'u1', status: 'busy' }] }),
    })
    expect(usePresenceStore.getState().statuses.u1).toBe('busy')
  })

  it('applies an update message for a single user', () => {
    connectPresenceSocket()
    const ws = MockWebSocket.instances[0]!
    ws.onmessage?.({ data: JSON.stringify({ type: 'update', user_id: 'u2', status: 'do_not_disturb' }) })
    expect(usePresenceStore.getState().statuses.u2).toBe('do_not_disturb')
  })

  it('ignores malformed frames instead of throwing', () => {
    connectPresenceSocket()
    const ws = MockWebSocket.instances[0]!
    expect(() => ws.onmessage?.({ data: 'not json' })).not.toThrow()
  })

  it('does not open a second socket while one is already connecting', () => {
    connectPresenceSocket()
    connectPresenceSocket()
    expect(MockWebSocket.instances).toHaveLength(1)
  })

  it('reconnects a fixed delay after the socket closes', () => {
    connectPresenceSocket()
    expect(MockWebSocket.instances).toHaveLength(1)
    MockWebSocket.instances[0]!.onclose?.()
    vi.advanceTimersByTime(3000)
    expect(MockWebSocket.instances).toHaveLength(2)
  })

  it('disconnectPresenceSocket closes the socket and cancels any pending reconnect', () => {
    connectPresenceSocket()
    const ws = MockWebSocket.instances[0]!
    disconnectPresenceSocket()
    expect(ws.closed).toBe(true)
    vi.advanceTimersByTime(10000)
    expect(MockWebSocket.instances).toHaveLength(1)
  })
})
