import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))
const listTeams = vi.fn()
const createTeam = vi.fn()
vi.mock('./client', () => ({ listTeams: () => listTeams(), createTeam: (...a: unknown[]) => createTeam(...a) }))

import { TeamsDashboard } from './TeamsDashboard'

const team = (over: object) => ({ id: 't1', name: 'Sales', description: '', role: 'owner', member_count: 3, unread: 0, ...over })

describe('TeamsDashboard', () => {
  beforeEach(() => {
    push.mockReset()
    createTeam.mockReset()
    listTeams.mockReset()
    listTeams.mockResolvedValue([team({ unread: 4 }), team({ id: 't2', name: 'Ops', member_count: 1 })])
  })

  it('renders a tile per team with member count and unread badge only when > 0', async () => {
    render(<TeamsDashboard />)
    const sales = await screen.findByRole('link', { name: /Sales/ })
    expect(sales).toHaveAttribute('href', '/app/teams/t1')
    expect(sales).toHaveTextContent('Members: 3')
    expect(sales).toHaveTextContent('4')
    const ops = screen.getByRole('link', { name: /Ops/ })
    expect(ops).toHaveAttribute('href', '/app/teams/t2')
    expect(ops).not.toHaveTextContent('0')
  })

  it('links the Direct messages tile to /teams/direct', async () => {
    render(<TeamsDashboard />)
    expect(await screen.findByRole('link', { name: /direct messages/i })).toHaveAttribute('href', '/app/teams/direct')
  })

  it('creates a team and navigates to it; empty name disables submit', async () => {
    createTeam.mockResolvedValue(team({ id: 'new' }))
    render(<TeamsDashboard />)
    fireEvent.click(await screen.findByRole('button', { name: /create team/i }))
    const submit = screen.getByRole('button', { name: /^create$/i })
    expect(submit).toBeDisabled()
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: ' Dev ' } })
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: 'd' } })
    fireEvent.click(submit)
    await waitFor(() => expect(createTeam).toHaveBeenCalledWith('Dev', 'd'))
    await waitFor(() => expect(push).toHaveBeenCalledWith('/app/teams/new'))
  })
})
