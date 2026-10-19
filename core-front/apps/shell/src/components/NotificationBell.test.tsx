import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useNotificationStore, type AppNotification } from '@eerp/core-front'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))
const markNotificationsRead = vi.fn(async () => {})
vi.mock('@/lib/notification-actions', () => ({ markNotificationsRead: (...a: unknown[]) => markNotificationsRead(...(a as [])) }))

import { NotificationBell } from './NotificationBell'

const n = (over: Partial<AppNotification>): AppNotification => ({
  id: 'x', category: 'dev_seed', kind: 'message', title: 'T', body: '', link: '/settings/developer',
  status: null, progress: null, progress_label: null, finished_at: null, created_at: new Date().toISOString(),
  data: null, read: false, ...over,
})

describe('NotificationBell', () => {
  beforeEach(() => {
    push.mockReset()
    markNotificationsRead.mockClear()
    useNotificationStore.setState({ items: [], unread: 0, hasNew: false, loaded: true })
  })

  it('shows the unread count and breathes only for a new arrival, until opened', () => {
    useNotificationStore.getState().setFeed([n({ id: 'a' })], 1)
    render(<NotificationBell />)
    expect(screen.getByRole('button', { name: /notifications/i })).toHaveTextContent('1')
    expect(screen.queryByTestId('notification-dot')).toBeNull()

    act(() => useNotificationStore.getState().upsert({ ...n({ id: 'b', title: 'Seed done' }) }))
    expect(screen.getByTestId('notification-dot')).toHaveClass('erp-breathe')

    fireEvent.click(screen.getByRole('button', { name: /notifications/i }))
    expect(screen.queryByTestId('notification-dot')).toBeNull()
  })

  it('lists running activities with progress, then the rest', () => {
    useNotificationStore.getState().setFeed([
      n({ id: 'run', kind: 'activity', status: 'running', title: 'Seeding demo data', progress: 40, progress_label: 'Seeding invoices (5/8)' }),
      n({ id: 'done', title: 'Demo data seeded in 38 s' }),
    ], 2)
    render(<NotificationBell />)
    fireEvent.click(screen.getByRole('button', { name: /notifications/i }))
    expect(screen.getByText('Running now')).toBeInTheDocument()
    expect(screen.getByText('Seeding invoices (5/8)')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40')
    expect(screen.getByText('Demo data seeded in 38 s')).toBeInTheDocument()
  })

  it('clicking an item marks it read and opens its ERP page', () => {
    useNotificationStore.getState().setFeed([n({ id: 'a', title: 'Seed done', link: '/settings/developer' })], 1)
    render(<NotificationBell />)
    fireEvent.click(screen.getByRole('button', { name: /notifications/i }))
    fireEvent.click(screen.getByText('Seed done'))
    expect(markNotificationsRead).toHaveBeenCalledWith(['a'])
    expect(push).toHaveBeenCalledWith('/app/settings/developer')
    expect(useNotificationStore.getState().unread).toBe(0)
  })

  it('never navigates to an external link', () => {
    useNotificationStore.getState().setFeed([n({ id: 'evil', title: 'Evil', link: '//evil.example' })], 1)
    render(<NotificationBell />)
    fireEvent.click(screen.getByRole('button', { name: /notifications/i }))
    fireEvent.click(screen.getByText('Evil'))
    expect(push).not.toHaveBeenCalled()
  })

  it('mark all as read', () => {
    useNotificationStore.getState().setFeed([n({ id: 'a' }), n({ id: 'b' })], 2)
    render(<NotificationBell />)
    fireEvent.click(screen.getByRole('button', { name: /notifications/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Mark all as read' }))
    expect(markNotificationsRead).toHaveBeenCalledWith('all')
    expect(useNotificationStore.getState().unread).toBe(0)
  })
})

describe('NotificationBell: reading and layout', () => {
  beforeEach(() => {
    markNotificationsRead.mockClear()
    useNotificationStore.setState({ items: [], unread: 0, hasNew: false, loaded: true })
  })
  afterEach(() => vi.useRealTimers())

  it('marks a notification read once the pointer rests on it', () => {
    vi.useFakeTimers()
    useNotificationStore.getState().setFeed([n({ id: 'a', title: 'Seed done' }), n({ id: 'b', title: 'Passed over' })], 2)
    render(<NotificationBell />)
    fireEvent.click(screen.getByRole('button', { name: /notifications/i }))

    // Passing over a row on the way somewhere else doesn't count.
    fireEvent.mouseEnter(screen.getByText('Passed over'))
    act(() => vi.advanceTimersByTime(300))
    fireEvent.mouseLeave(screen.getByText('Passed over'))
    act(() => vi.advanceTimersByTime(1000))
    expect(markNotificationsRead).not.toHaveBeenCalled()

    fireEvent.mouseEnter(screen.getByText('Seed done'))
    act(() => vi.advanceTimersByTime(700))
    expect(markNotificationsRead).toHaveBeenCalledWith(['a'])
    expect(useNotificationStore.getState().unread).toBe(1)
  })

  it('opens the panel centered at 90% of the screen on a phone', () => {
    const real = window.matchMedia
    window.matchMedia = ((query: string) => ({
      matches: true, media: query, onchange: null, addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })) as typeof window.matchMedia
    try {
      render(<NotificationBell />)
      fireEvent.click(screen.getByRole('button', { name: /notifications/i }))
      const panel = screen.getByTestId('notification-panel')
      expect(panel).toHaveAttribute('data-layout', 'phone')
      // In front of the page as a dialog (centered by its container, not by a
      // transform the open animation would overwrite), over a blurred backdrop.
      expect(screen.getByRole('dialog')).toContainElement(panel)
      // 90vw × 90vh, which getComputedStyle resolves against the window.
      expect(panel).toHaveStyle({ width: `${window.innerWidth * 0.9}px`, height: `${window.innerHeight * 0.9}px` })
      expect(screen.getByTestId('notification-backdrop')).toBeInTheDocument()
    } finally {
      window.matchMedia = real
    }
  })

  it('anchors the panel under the bell otherwise', () => {
    render(<NotificationBell />)
    fireEvent.click(screen.getByRole('button', { name: /notifications/i }))
    expect(screen.getByTestId('notification-panel')).toHaveAttribute('data-layout', 'anchored')
  })
})

describe('NotificationBell: separators', () => {
  it('draws a centered 0.5px bar, 70% of the panel wide, between notifications', () => {
    useNotificationStore.setState({ items: [], unread: 0, hasNew: false, loaded: true })
    useNotificationStore.getState().setFeed([n({ id: 'a', title: 'One' }), n({ id: 'b', title: 'Two' }), n({ id: 'c', title: 'Three' })], 3)
    render(<NotificationBell />)
    fireEvent.click(screen.getByRole('button', { name: /notifications/i }))
    const bars = screen.getAllByTestId('notification-separator')
    expect(bars).toHaveLength(2) // between three rows, none after the last
    expect(bars[0]).toHaveStyle({ width: '70%', borderTopWidth: '0.5px', borderTopStyle: 'solid' })
  })
})

describe('NotificationBell: sizing and phone close', () => {
  const real = window.matchMedia
  const phoneMedia = () => {
    window.matchMedia = ((query: string) => ({
      matches: true, media: query, onchange: null, addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })) as typeof window.matchMedia
  }
  afterEach(() => {
    window.matchMedia = real
  })

  it('keeps a wide gap before the company switcher, and a 16px bell on desktop', () => {
    render(<NotificationBell />)
    expect(screen.getByRole('button', { name: /notifications/i })).toHaveStyle({ marginRight: '24px' })
    expect(screen.getByTestId('notification-bell-icon')).toHaveStyle({ fontSize: '16px' })
  })

  it('grows the bell by 3px per side on a phone', () => {
    phoneMedia()
    render(<NotificationBell />)
    expect(screen.getByTestId('notification-bell-icon')).toHaveStyle({ fontSize: '22px' })
  })

  it('closes the phone panel from its close button', async () => {
    phoneMedia()
    render(<NotificationBell />)
    fireEvent.click(screen.getByRole('button', { name: /notifications/i }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})
