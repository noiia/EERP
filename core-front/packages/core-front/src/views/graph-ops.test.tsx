import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { GraphOpsProvider, useGraphOps } from './graph-ops'

function Probe() {
  const ops = useGraphOps()
  return <div>{ops ? 'has-ops' : 'no-ops'}</div>
}

describe('GraphOps context', () => {
  it('is null with no provider mounted (inert, not a crash)', () => {
    render(<Probe />)
    expect(screen.getByText('no-ops')).toBeInTheDocument()
  })

  it('exposes the bound ops the host provides', () => {
    const ops = { get: vi.fn(), save: vi.fn() }
    render(
      <GraphOpsProvider ops={ops}>
        <Probe />
      </GraphOpsProvider>,
    )
    expect(screen.getByText('has-ops')).toBeInTheDocument()
  })
})
