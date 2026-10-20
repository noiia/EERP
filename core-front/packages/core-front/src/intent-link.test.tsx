import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

const prefetch = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ prefetch }) }))

import { IntentLink } from './intent-link'

afterEach(() => prefetch.mockClear())

describe('IntentLink', () => {
  it('does not prefetch just for being rendered', () => {
    render(<IntentLink href="/app/crm">CRM</IntentLink>)
    expect(screen.getByRole('link', { name: 'CRM' })).toHaveAttribute('href', '/app/crm')
    expect(prefetch).not.toHaveBeenCalled()
  })

  it.each([
    ['hover', (el: HTMLElement) => fireEvent.mouseEnter(el)],
    ['focus', (el: HTMLElement) => fireEvent.focus(el)],
    ['touch', (el: HTMLElement) => fireEvent.touchStart(el)],
  ])('prefetches on %s, once', (_name, intent) => {
    render(<IntentLink href="/app/crm">CRM</IntentLink>)
    const link = screen.getByRole('link', { name: 'CRM' })
    intent(link)
    intent(link)
    expect(prefetch).toHaveBeenCalledTimes(1)
    expect(prefetch).toHaveBeenCalledWith('/app/crm')
  })

  it('still runs the caller own handlers', () => {
    const onMouseEnter = vi.fn()
    render(
      <IntentLink href="/app/crm" onMouseEnter={onMouseEnter}>
        CRM
      </IntentLink>,
    )
    fireEvent.mouseEnter(screen.getByRole('link', { name: 'CRM' }))
    expect(onMouseEnter).toHaveBeenCalled()
  })
})
