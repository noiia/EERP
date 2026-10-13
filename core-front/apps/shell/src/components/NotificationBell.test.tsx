import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
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
