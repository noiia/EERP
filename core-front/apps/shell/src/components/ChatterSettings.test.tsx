import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const setEntityChatterVisibility = vi.hoisted(() => vi.fn())
vi.mock('@/lib/chatter-visibility', () => ({ setEntityChatterVisibility }))

import ChatterSettings, { type ChatterEntityRow } from './ChatterSettings'

const rows: ChatterEntityRow[] = [
  { entity: 'crm', moduleDefault: undefined, config: { enabled: null } },
]

beforeEach(() => {
  setEntityChatterVisibility.mockReset()
})

describe('ChatterSettings', () => {
  it('renders nothing without entities', () => {
    const { container } = render(<ChatterSettings rows={[]} canEdit />)
    expect(container).toBeEmptyDOMElement()
  })

  it('saves a toggle', async () => {
    setEntityChatterVisibility.mockResolvedValue({ ok: true })
    render(<ChatterSettings rows={rows} canEdit />)
    const toggle = screen.getByRole('switch')
    expect(toggle).toBeChecked() // no module opinion + no override = shown
    fireEvent.click(toggle)
    await waitFor(() => expect(setEntityChatterVisibility).toHaveBeenCalledWith('crm', false))
    expect(toggle).not.toBeChecked()
  })

  it('reverts the toggle and shows the error when the save fails', async () => {
    setEntityChatterVisibility.mockResolvedValue({ ok: false, message: 'Missing permission' })
    render(<ChatterSettings rows={rows} canEdit />)
    fireEvent.click(screen.getByRole('switch'))
    expect(await screen.findByText('Missing permission')).toBeInTheDocument()
    expect(screen.getByRole('switch')).toBeChecked()
  })

  it('is read-only without edit rights', () => {
    render(<ChatterSettings rows={rows} canEdit={false} />)
    expect(screen.getByRole('switch')).toBeDisabled()
  })
})
