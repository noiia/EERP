'use client'

import { useEffect } from 'react'

/** Shows "EERP - <name>" in the browser tab while mounted with a name; the previous title comes back on change/unmount (a document dialog closing returns to its page's title). */
export function useDocumentTitle(name: string | null | undefined) {
  useEffect(() => {
    if (!name) return
    const previous = document.title
    document.title = `EERP - ${name}`
    return () => {
      document.title = previous
    }
  }, [name])
}
