import { afterEach, describe, expect, it } from 'vitest'
import { act, render } from '@testing-library/react'
import { useUiStore } from '@eerp/core-front'
import { ErpUiStyle } from './ErpUiStyle'

const css = () => Array.from(document.querySelectorAll('style')).map((s) => s.textContent).join('\n')

describe('ErpUiStyle', () => {
  afterEach(() => useUiStore.getState().setUiStyle('pretty'))

  it('injects the pretty rules by default and swaps to performance rules', () => {
    const { unmount } = render(<ErpUiStyle />)
    expect(css()).toContain('erp-enter')
    act(() => useUiStore.getState().setUiStyle('performance'))
    expect(css()).not.toContain('erp-enter')
    expect(css()).toContain('MuiTouchRipple-root')
    unmount()
  })
})
