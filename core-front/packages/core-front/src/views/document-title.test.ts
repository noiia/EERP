import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useDocumentTitle } from './document-title'

describe('useDocumentTitle', () => {
  beforeEach(() => {
    document.title = 'EERP'
  })

  it('prefixes the name and restores the previous title on unmount', () => {
    const { unmount } = renderHook(() => useDocumentTitle('Contacts'))
    expect(document.title).toBe('EERP - Contacts')
    unmount()
    expect(document.title).toBe('EERP')
  })

  it('nests: a dialog title gives back its page title', () => {
    const page = renderHook(() => useDocumentTitle('Files'))
    const dialog = renderHook(() => useDocumentTitle('report.docx'))
    expect(document.title).toBe('EERP - report.docx')
    dialog.unmount()
    expect(document.title).toBe('EERP - Files')
    page.unmount()
  })

  it('leaves the title alone without a name', () => {
    renderHook(() => useDocumentTitle(null))
    expect(document.title).toBe('EERP')
  })
})
