import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SavedFilterOpsProvider, useSavedFilterOps } from './saved-filter-ops'

function Probe() {
  const ops = useSavedFilterOps()
  return <div>{ops ? 'has-ops' : 'no-ops'}</div>
}

describe('SavedFilterOps context', () => {
  it('is null with no provider mounted (inert, not a crash)', () => {
    render(<Probe />)
    expect(screen.getByText('no-ops')).toBeInTheDocument()
  })

  it('exposes the bound ops the host provides', () => {
    const ops = { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() }
    render(
      <SavedFilterOpsProvider ops={ops}>
        <Probe />
      </SavedFilterOpsProvider>,
    )
    expect(screen.getByText('has-ops')).toBeInTheDocument()
  })
})
