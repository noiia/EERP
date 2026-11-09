import { beforeEach, describe, expect, it, vi } from 'vitest'

const redirect = vi.fn((url: string) => { throw new Error(`REDIRECT ${url}`) })
const notFound = vi.fn(() => { throw new Error('NOT_FOUND') })
vi.mock('next/navigation', () => ({ redirect: (u: string) => redirect(u), notFound: () => notFound() }))
vi.mock('@/lib/session', () => ({ requireAuth: vi.fn() }))
const active = vi.fn()
vi.mock('@/lib/module-state', () => ({ activeModuleNames: () => active() }))
const apiRequest = vi.fn()
vi.mock('@eerp/core-front/server', () => ({
  apiRequest: (...a: unknown[]) => apiRequest(...a),
  erpPath: (p: string) => `/app${p}`,
}))
vi.mock('@/teams/TeamsWorkspace', () => ({ TeamsWorkspace: () => null }))

import TeamPage from './[id]/page'
import DirectPage from './direct/page'
import TeamChannelPage from './[id]/channels/[channel]/page'
import DirectChannelPage from './direct/[channel]/page'

describe('teams pages', () => {
  beforeEach(() => {
    active.mockResolvedValue(new Set(['teams']))
    apiRequest.mockReset()
  })

  it('/teams/[id] redirects to the first channel', async () => {
    apiRequest.mockResolvedValue({ data: [{ id: 'c1' }, { id: 'c2' }] })
    await expect(TeamPage({ params: Promise.resolve({ id: 't1' }) })).rejects.toThrow('REDIRECT /app/teams/t1/channels/c1')
    expect(apiRequest).toHaveBeenCalledWith('GET', '/teams/t1/channels')
  })

  it('/teams/[id] is a 404 when Go refuses the team', async () => {
    apiRequest.mockRejectedValue(new Error('nope'))
    await expect(TeamPage({ params: Promise.resolve({ id: 't1' }) })).rejects.toThrow('NOT_FOUND')
  })

  it('/teams/direct redirects to the latest conversation, else renders the empty workspace', async () => {
    apiRequest.mockResolvedValue({ data: [{ id: 'd1' }] })
    await expect(DirectPage()).rejects.toThrow('REDIRECT /app/teams/direct/d1')
    apiRequest.mockResolvedValue({ data: [] })
    await expect(DirectPage()).resolves.toBeTruthy()
  })

  it('chat pages are a 404 while the module is inactive', async () => {
    active.mockResolvedValue(new Set())
    await expect(TeamChannelPage({ params: Promise.resolve({ id: 't1', channel: 'c1' }) })).rejects.toThrow('NOT_FOUND')
    await expect(DirectChannelPage({ params: Promise.resolve({ channel: 'd1' }) })).rejects.toThrow('NOT_FOUND')
    active.mockResolvedValue(new Set(['teams']))
    await expect(TeamChannelPage({ params: Promise.resolve({ id: 't1', channel: 'c1' }) })).resolves.toBeTruthy()
    await expect(DirectChannelPage({ params: Promise.resolve({ channel: 'd1' }) })).resolves.toBeTruthy()
  })
})
