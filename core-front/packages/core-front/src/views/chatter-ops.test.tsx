import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ChatterOpsProvider, useChatterOps } from './chatter-ops'

function Probe() {
  const ops = useChatterOps()
  return <div>{ops ? 'has-ops' : 'no-ops'}</div>
}

describe('ChatterOps context', () => {
  it('is null with no provider mounted (inert, not a crash)', () => {
    render(<Probe />)
    expect(screen.getByText('no-ops')).toBeInTheDocument()
  })

  it('exposes the bound ops the host provides', () => {
    const ops = { list: vi.fn(), create: vi.fn() }
    render(
      <ChatterOpsProvider ops={ops}>
        <Probe />
      </ChatterOpsProvider>,
    )
    expect(screen.getByText('has-ops')).toBeInTheDocument()
  })
})
