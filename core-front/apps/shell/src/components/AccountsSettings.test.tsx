import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

// The save is a Server Action; the component only sees its result object.
const saveMock = vi.fn()
vi.mock('@/lib/preferences', () => ({
  setUsernameAtFormat: (usernameAtFormat: boolean) => saveMock(usernameAtFormat),
}))

import AccountsSettings from './AccountsSettings'

beforeEach(() => {
  saveMock.mockReset()
  saveMock.mockResolvedValue({ ok: true })
})

describe('AccountsSettings', () => {
  it('shows the stored value', () => {
    render(<AccountsSettings canEdit initialUsernameAtFormat={true} />)
    expect(screen.getByLabelText(/display usernames with a leading/i)).toBeChecked()
  })

  it('saves immediately when toggled', async () => {
    render(<AccountsSettings canEdit initialUsernameAtFormat={false} />)
    fireEvent.click(screen.getByLabelText(/display usernames with a leading/i))
    await waitFor(() => expect(saveMock).toHaveBeenCalledWith(true))
  })

  it('surfaces the error message on a failed save', async () => {
    saveMock.mockResolvedValue({ ok: false, message: 'Missing permission settings:accounts:write' })
    render(<AccountsSettings canEdit initialUsernameAtFormat={false} />)
    fireEvent.click(screen.getByLabelText(/display usernames with a leading/i))
    expect(await screen.findByText('Missing permission settings:accounts:write')).toBeInTheDocument()
  })

  it('renders read-only without the write permission', () => {
    render(<AccountsSettings canEdit={false} initialUsernameAtFormat={false} />)
    expect(screen.getByLabelText(/display usernames with a leading/i)).toBeDisabled()
    expect(screen.getByText(/settings:accounts:write permission/)).toBeInTheDocument()
  })
})
