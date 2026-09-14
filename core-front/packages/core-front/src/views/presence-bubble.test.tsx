import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AvatarWithPresence, PresenceDot } from './presence-bubble'
import { usePresenceStore } from './presence-store'

beforeEach(() => {
  usePresenceStore.setState({ statuses: {} })
})

describe('PresenceDot', () => {
  it('renders filled for online', () => {
    const { container } = render(<PresenceDot status="online" />)
    const dot = container.firstChild as HTMLElement
    expect(dot).toHaveStyle({ backgroundColor: 'rgb(108, 187, 88)' })
  })

  it('renders a white bar for do_not_disturb, unlike plain busy', () => {
    const { container: dnd } = render(<PresenceDot status="do_not_disturb" />)
    const { container: busy } = render(<PresenceDot status="busy" />)
    expect(dnd.querySelectorAll('div').length).toBeGreaterThan(busy.querySelectorAll('div').length)
  })
})

describe('AvatarWithPresence', () => {
  it('shows the initial letter of the label', () => {
    render(<AvatarWithPresence userId="u1" label="alice@example.com" />)
    expect(screen.getByText('A')).toBeInTheDocument()
  })

  it('defaults an unknown user to the offline bubble', () => {
    const { container } = render(<AvatarWithPresence userId="unknown-user" label="x" />)
    // offline renders hollow (transparent-ish) rather than one of the filled colors.
    expect(container.innerHTML).not.toContain('rgb(108, 187, 88)') // not online-green
  })

  it('re-renders when the store pushes a status update for this user', () => {
    const { rerender } = render(<AvatarWithPresence userId="u2" label="bob" />)
    usePresenceStore.getState().setOne('u2', 'busy')
    rerender(<AvatarWithPresence userId="u2" label="bob" />)
    expect(screen.getByText('B')).toBeInTheDocument()
  })
})
