'use client'
import { useEffect, useMemo, useRef, useState } from 'react'

// Undo/redo stacks for a diagram's user actions. An entry knows how to undo and redo
// itself (server writes included); a new action clears the redo stack. One step runs at a
// time: a key press while one is in flight is ignored. A step that fails is dropped and
// reported to `onError`.

export interface HistoryEntry {
  undo: () => unknown
  redo: () => unknown
}

export interface UndoHistory {
  push: (entry: HistoryEntry) => void
  /** Runs `redo` now and records it once it succeeded; a failure goes to `onError`. */
  perform: (redo: () => unknown, undo: () => unknown) => Promise<void>
  undo: () => Promise<void>
  redo: () => Promise<void>
  canUndo: boolean
  canRedo: boolean
}

export const HISTORY_LIMIT = 100

export function useUndoHistory(onError?: (e: unknown) => void): UndoHistory {
  const done = useRef<HistoryEntry[]>([])
  const undone = useRef<HistoryEntry[]>([])
  const busy = useRef(false)
  const errorRef = useRef(onError)
  useEffect(() => {
    errorRef.current = onError
  })
  // Bumped on every stack change so canUndo/canRedo re-render.
  const [version, setVersion] = useState(0)
  const bump = () => setVersion((v) => v + 1)

  const step = async (from: HistoryEntry[], to: HistoryEntry[], run: (e: HistoryEntry) => unknown) => {
    const entry = from.at(-1)
    if (!entry || busy.current) return
    busy.current = true
    from.pop()
    try {
      await run(entry)
      to.push(entry)
    } catch (e: unknown) {
      errorRef.current?.(e)
    } finally {
      busy.current = false
      bump()
    }
  }

  const push = (entry: HistoryEntry) => {
    done.current.push(entry)
    if (done.current.length > HISTORY_LIMIT) done.current.shift()
    undone.current.length = 0
    bump()
  }

  return useMemo(
    () => ({
      push,
      perform: async (redo: () => unknown, undo: () => unknown) => {
        try {
          await redo()
          push({ undo, redo })
        } catch (e: unknown) {
          errorRef.current?.(e)
        }
      },
      undo: () => step(done.current, undone.current, (e) => e.undo()),
      redo: () => step(undone.current, done.current, (e) => e.redo()),
      canUndo: done.current.length > 0,
      canRedo: undone.current.length > 0,
    }),
    [version],
  )
}

/** Ctrl/Cmd+Z undoes; Ctrl/Cmd+Y or Ctrl/Cmd+Shift+Z redoes — not while typing in a field
 * (its own text undo wins there). */
export function historyKey(e: KeyboardEvent): 'undo' | 'redo' | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null
  const target = e.target as HTMLElement | null
  if (target?.closest?.('input, textarea, select, [contenteditable="true"]')) return null
  const key = e.key.toLowerCase()
  if (key === 'z') return e.shiftKey ? 'redo' : 'undo'
  if (key === 'y' && !e.shiftKey) return 'redo'
  return null
}
