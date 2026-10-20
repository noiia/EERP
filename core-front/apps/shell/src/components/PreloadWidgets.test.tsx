import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'

const preload = vi.fn(() => Promise.resolve())
vi.mock('@eerp/core-front', () => ({ preloadLazyComponents: () => preload() }))

import { PreloadWidgets } from './PreloadWidgets'

afterEach(() => {
  preload.mockClear()
  vi.useRealTimers()
})

describe('PreloadWidgets', () => {
  it('loads the lazy widget chunks once the page is idle', () => {
    vi.useFakeTimers()
    render(<PreloadWidgets />)
    expect(preload).not.toHaveBeenCalled()
    vi.runAllTimers()
    expect(preload).toHaveBeenCalledTimes(1)
  })

  it('cancels the pending load on unmount', () => {
    vi.useFakeTimers()
    const { unmount } = render(<PreloadWidgets />)
    unmount()
    vi.runAllTimers()
    expect(preload).not.toHaveBeenCalled()
  })
})
