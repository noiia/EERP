import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

const nav = vi.hoisted(() => ({ segments: [] as string[], folder: null as string | null }))
vi.mock('next/navigation', () => ({
  useSelectedLayoutSegments: () => nav.segments,
  useSearchParams: () => new URLSearchParams(nav.folder ? { folder: nav.folder } : {}),
}))
vi.mock('./TeamsWorkspace', () => ({
  TeamsWorkspace: ({ teamId, view }: { teamId?: string; view: { kind: string; id?: string } }) => <p>{`ws ${teamId ?? '-'} ${view.kind} ${view.id ?? '-'}`}</p>,
}))

import { routeOf, TeamsShell } from './TeamsShell'

describe('routeOf', () => {
  it.each([
    [[], undefined, null],
    [['shared'], undefined, { view: { kind: 'shared' } }],
    [['direct'], undefined, { view: { kind: 'direct', id: undefined } }],
    [['direct', 'd1'], undefined, { view: { kind: 'direct', id: 'd1' } }],
    [['t1'], undefined, { teamId: 't1', view: { kind: 'channel', id: undefined } }],
    [['t1', 'channels', 'c1', '__PAGE__'], undefined, { teamId: 't1', view: { kind: 'channel', id: 'c1' } }],
    [['t1', 'files'], 'f1', { teamId: 't1', view: { kind: 'files', id: 'f1' } }],
  ])('%j', (segments, folder, want) => expect(routeOf(segments, folder)).toEqual(want))
})

describe('TeamsShell', () => {
  it('keeps the last team on direct messages, drops it on the dashboard', () => {
    nav.segments = ['t1', 'channels', 'c1']
    const { rerender } = render(<TeamsShell><i>page</i></TeamsShell>)
    expect(screen.getByText('ws t1 channel c1')).toBeInTheDocument()
    nav.segments = ['direct', 'd1']
    rerender(<TeamsShell><i>page</i></TeamsShell>)
    expect(screen.getByText('ws t1 direct d1')).toBeInTheDocument()
    nav.segments = []
    rerender(<TeamsShell><i>page</i></TeamsShell>)
    expect(screen.getByText('page')).toBeInTheDocument()
    nav.segments = ['shared']
    rerender(<TeamsShell><i>page</i></TeamsShell>)
    expect(screen.getByText('ws - shared -')).toBeInTheDocument()
  })
})
