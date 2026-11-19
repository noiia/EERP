import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { preloadLazyComponents } from '@eerp/core-front'

vi.mock('./client', () => ({
  listShared: () =>
    Promise.resolve([
      {
        id: 's1',
        name: 'plan.pdf',
        mime: '',
        size: 5,
        team_id: 't1',
        team_name: 'Sales',
        shared_by_name: 'Alice',
        created_at: '',
      },
      {
        id: 's2',
        name: 'Plan.docx',
        mime: 'application/json',
        size: 10,
        team_id: 't1',
        team_name: 'Sales',
        shared_by_name: 'Alice',
        created_at: '',
      },
    ]),
}))
import { SharedPane } from './SharedPane'

beforeAll(() => preloadLazyComponents())
afterEach(() => vi.unstubAllGlobals())

describe('SharedPane', () => {
  it('opens shared Office files', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 503 })))
    render(<SharedPane />)
    fireEvent.click(await screen.findByRole('link', { name: 'Plan.docx' }))
    expect(
      await screen.findByText('The document could not be opened. Try again or download the file.'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  })
  it('lists files with team and sharer', async () => {
    render(<SharedPane />)
    expect(await screen.findByRole('link', { name: 'plan.pdf' })).toHaveAttribute(
      'href',
      '/api/teams/files/s1/download',
    )
    expect(screen.getAllByText('Sales')).toHaveLength(2)
    expect(screen.getAllByText('Alice')).toHaveLength(2)
  })
})
