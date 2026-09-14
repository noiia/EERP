import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { UndoToastHost, useUndoToastStore } from './undo-toast'

beforeEach(() => {
  useUndoToastStore.setState({ pending: null })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useUndoToastStore', () => {
  it('recover() cancels the timer and calls onRecover, never onExpire', () => {
    vi.useFakeTimers()
    const onRecover = vi.fn()
    const onExpire = vi.fn()
    useUndoToastStore.getState().show({ message: 'Deleted "Open deals"', onRecover, onExpire })

    useUndoToastStore.getState().recover()
    vi.advanceTimersByTime(10_000)

    expect(onRecover).toHaveBeenCalledTimes(1)
    expect(onExpire).not.toHaveBeenCalled()
    expect(useUndoToastStore.getState().pending).toBeNull()
  })

  it('letting the window elapse un-recovered calls onExpire, never onRecover', () => {
    vi.useFakeTimers()
    const onRecover = vi.fn()
    const onExpire = vi.fn()
    useUndoToastStore.getState().show({ message: 'Deleted "Open deals"', onRecover, onExpire })

    vi.advanceTimersByTime(6000)

    expect(onExpire).toHaveBeenCalledTimes(1)
    expect(onRecover).not.toHaveBeenCalled()
    expect(useUndoToastStore.getState().pending).toBeNull()
  })

  it('dismiss() hides the pending state but leaves the onExpire timer running', () => {
    vi.useFakeTimers()
    const onExpire = vi.fn()
    useUndoToastStore.getState().show({ message: 'Deleted', onRecover: vi.fn(), onExpire })

    useUndoToastStore.getState().dismiss()
    expect(useUndoToastStore.getState().pending).toBeNull()
    expect(onExpire).not.toHaveBeenCalled()

    vi.advanceTimersByTime(6000)
    expect(onExpire).toHaveBeenCalledTimes(1)
  })

  it('a second show() while one is pending immediately expires the first (single slot, not queued)', () => {
    vi.useFakeTimers()
    const firstExpire = vi.fn()
    const secondRecover = vi.fn()
    useUndoToastStore.getState().show({ message: 'First', onRecover: vi.fn(), onExpire: firstExpire })
    useUndoToastStore.getState().show({ message: 'Second', onRecover: secondRecover })

    expect(firstExpire).toHaveBeenCalledTimes(1)
    expect(useUndoToastStore.getState().pending?.message).toBe('Second')

    useUndoToastStore.getState().recover()
    expect(secondRecover).toHaveBeenCalledTimes(1)
  })

  it('a no-onExpire (eager-commit) show() lets the window elapse with no crash and no callback', () => {
    vi.useFakeTimers()
    useUndoToastStore.getState().show({ message: 'Unscheduled', onRecover: vi.fn() })
    expect(() => vi.advanceTimersByTime(6000)).not.toThrow()
    expect(useUndoToastStore.getState().pending).toBeNull()
  })
})

describe('UndoToastHost', () => {
  it('renders nothing when no toast is pending', () => {
    render(<UndoToastHost />)
    expect(screen.queryByText('Recover')).not.toBeInTheDocument()
  })

  it('shows the message with Recover (left) and dismiss (right) once a toast is pending', async () => {
    render(<UndoToastHost />)
    useUndoToastStore.getState().show({ message: 'Deleted "Open deals"', onRecover: vi.fn() })

    expect(await screen.findByText('Deleted "Open deals"')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Recover' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument()
  })

  it('clicking Recover calls onRecover and hides the toast', async () => {
    render(<UndoToastHost />)
    const onRecover = vi.fn()
    useUndoToastStore.getState().show({ message: 'Deleted', onRecover })

    fireEvent.click(await screen.findByRole('button', { name: 'Recover' }))

    expect(onRecover).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByText('Deleted')).not.toBeInTheDocument())
  })

  it('clicking Dismiss hides the toast without calling onRecover', async () => {
    render(<UndoToastHost />)
    const onRecover = vi.fn()
    useUndoToastStore.getState().show({ message: 'Deleted', onRecover })

    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }))

    expect(onRecover).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByText('Deleted')).not.toBeInTheDocument())
  })
})
