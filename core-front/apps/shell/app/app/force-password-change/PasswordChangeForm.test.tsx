import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => router }))
const changeMyPassword = vi.hoisted(() => vi.fn())
vi.mock('@/lib/force-password-change', () => ({ changeMyPassword }))

import PasswordChangeForm from './PasswordChangeForm'
import type { SelfUserProfile } from '@/lib/force-password-change'

const profile = { id: 'u1', email: 'admin@eerp.local' } as SelfUserProfile

function fill(password: string, confirm: string) {
  fireEvent.change(screen.getByLabelText(/^New password/), { target: { value: password } })
  fireEvent.change(screen.getByLabelText(/^Confirm new password/), { target: { value: confirm } })
  fireEvent.click(screen.getByRole('button', { name: 'Save and continue' }))
}

beforeEach(() => {
  router.push.mockReset()
  router.refresh.mockReset()
  changeMyPassword.mockReset()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 200 })),
  )
})

describe('PasswordChangeForm', () => {
  it('disables the form when the profile could not be loaded', () => {
    render(<PasswordChangeForm profile={null} />)
    expect(screen.getByRole('button', { name: 'Save and continue' })).toBeDisabled()
    expect(screen.getByText(/Could not load your profile/)).toBeInTheDocument()
  })

  it.each([
    [
      'a password shorter than 8 characters',
      'short',
      'short',
      'Password must be at least 8 characters.',
    ],
    ['mismatched confirmation', 'longenough1', 'longenough2', 'Passwords do not match.'],
  ])('rejects %s without calling the server', async (_, password, confirm, message) => {
    render(<PasswordChangeForm profile={profile} />)
    fill(password, confirm)
    expect(await screen.findByText(message)).toBeInTheDocument()
    expect(changeMyPassword).not.toHaveBeenCalled()
  })

  it('shows the server error and stays on the page when the change fails', async () => {
    changeMyPassword.mockResolvedValue({ ok: false, message: 'Password too weak' })
    render(<PasswordChangeForm profile={profile} />)
    fill('longenough1', 'longenough1')
    expect(await screen.findByText('Password too weak')).toBeInTheDocument()
    expect(router.push).not.toHaveBeenCalled()
  })

  it('changes the password, refreshes the session and goes home', async () => {
    changeMyPassword.mockResolvedValue({ ok: true })
    render(<PasswordChangeForm profile={profile} />)
    fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: 'me@x.test' } })
    fill('longenough1', 'longenough1')
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/app'))
    expect(changeMyPassword).toHaveBeenCalledWith(profile, 'longenough1', 'me@x.test')
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('refresh'), { method: 'POST' })
    expect(router.refresh).toHaveBeenCalled()
  })
})
