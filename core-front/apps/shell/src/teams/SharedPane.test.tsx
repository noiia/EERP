import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('./client', () => ({
  listShared: () => Promise.resolve([{ id: 's1', name: 'plan.pdf', mime: '', size: 5, team_id: 't1', team_name: 'Sales', shared_by_name: 'Alice', created_at: '' }]),
}))
import { SharedPane } from './SharedPane'

describe('SharedPane', () => {
  it('lists files with team and sharer', async () => {
    render(<SharedPane />)
    expect(await screen.findByRole('link', { name: 'plan.pdf' })).toHaveAttribute('href', '/api/teams/files/s1/download')
    expect(screen.getByText('Sales')).toBeInTheDocument()
    expect(screen.getByText('Alice')).toBeInTheDocument()
  })
})
