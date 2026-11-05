import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }))

import { SEARCH_DEBOUNCE_MS, SearchBlock } from './SearchBlock'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); push.mockReset() })

describe('SearchBlock', () => {
  it('fetches grouped results after a pause and opens the picked one', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      groups: [{ table: 'product', label: 'Products', hits: [{ id: 'p1', title: 'Chair', href: '/item/p1' }] }],
    })))
    vi.stubGlobal('fetch', fetchMock)
    render(<SearchBlock config={{ targets: [], placeholder: 'Find' }} pageId="page 1" blockId="s1" />)
    const input = screen.getByRole('combobox', { name: 'Find' })
    fireEvent.change(input, { target: { value: 'ch' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS) })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('/api/site-search/page%201/s1?q=ch')
    expect(screen.getByText('Products')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Chair'))
    expect(push).toHaveBeenCalledWith('/item/p1')
  })

  it('does not fetch under two characters, nor in the editor preview', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { rerender } = render(<SearchBlock config={{ targets: [] }} pageId="p" blockId="s1" />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'c' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS * 2) })
    expect(fetchMock).not.toHaveBeenCalled()
    rerender(<SearchBlock config={{ targets: [] }} blockId="s1" />)
    expect(screen.getByRole('combobox')).toBeDisabled()
  })
})
