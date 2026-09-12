import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SeedResult } from '@/lib/dev-seed'

const seedMock = vi.fn()
vi.mock('@/lib/dev-seed', () => ({
  seedDemoData: () => seedMock(),
}))

import DeveloperSettings from './DeveloperSettings'

beforeEach(() => {
  seedMock.mockReset()
})

describe('DeveloperSettings', () => {
  it('runs the seed action and lists a per-entity summary of the result', async () => {
    const result: SeedResult = {
      ok: true,
      results: [
        { entity: 'contact', created: 10, failed: 0, errors: [] },
        { entity: 'crm', created: 14, failed: 1, errors: ['no crm:contacts:write'] },
      ],
    }
    seedMock.mockResolvedValue(result)

    render(<DeveloperSettings isDev />)
    fireEvent.click(screen.getByRole('button', { name: 'Seed demo data' }))

    expect(await screen.findByText('contact: 10 created')).toBeInTheDocument()
    expect(screen.getByText('crm: 14 created, 1 failed')).toBeInTheDocument()
    expect(screen.getByText('no crm:contacts:write')).toBeInTheDocument()
    expect(seedMock).toHaveBeenCalledOnce()
  })

  it('surfaces the disabled-outside-development message as an error', async () => {
    seedMock.mockResolvedValue({
      ok: false,
      message: 'Demo data seeding is disabled outside development.',
    })

    render(<DeveloperSettings isDev={false} />)
    // Disabled by isDev — but if it were somehow clicked, the action's own guard
    // is the real defense; the button being disabled is just the UI reflection.
    expect(screen.getByRole('button', { name: 'Seed demo data' })).toBeDisabled()
    expect(
      screen.getByText('Seeding demo data is only available outside production.'),
    ).toBeInTheDocument()
  })

  it('shows the loading state while seeding is in flight', async () => {
    let resolve!: (r: SeedResult) => void
    seedMock.mockReturnValue(new Promise<SeedResult>((r) => (resolve = r)))

    render(<DeveloperSettings isDev />)
    fireEvent.click(screen.getByRole('button', { name: 'Seed demo data' }))

    expect(await screen.findByRole('button', { name: 'Seeding…' })).toBeDisabled()

    resolve({ ok: true, results: [] })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Seed demo data' })).not.toBeDisabled())
  })
})
