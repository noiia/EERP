import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { NotebookOpsProvider, useNotebookOps } from './notebook-ops'

function Probe() {
  const ops = useNotebookOps()
  return <div>{ops ? 'has-ops' : 'no-ops'}</div>
}

describe('NotebookOps context', () => {
  it('is null with no provider mounted (inert, not a crash)', () => {
    render(<Probe />)
    expect(screen.getByText('no-ops')).toBeInTheDocument()
  })

  it('exposes the bound ops the host provides', () => {
    const ops = { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() }
    render(
      <NotebookOpsProvider ops={ops}>
        <Probe />
      </NotebookOpsProvider>,
    )
    expect(screen.getByText('has-ops')).toBeInTheDocument()
  })
})
