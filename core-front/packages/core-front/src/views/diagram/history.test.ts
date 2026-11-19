import { describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { HISTORY_LIMIT, historyKey, useUndoHistory } from './history'

const entry = (log: string[], name: string) => ({ undo: () => log.push(`undo ${name}`), redo: () => log.push(`redo ${name}`) })

describe('useUndoHistory', () => {
  it('undoes and redoes in order; a new action clears redo', async () => {
    const log: string[] = []
    const { result } = renderHook(() => useUndoHistory())
    expect(result.current.canUndo).toBe(false)
    act(() => result.current.push(entry(log, 'a')))
    act(() => result.current.push(entry(log, 'b')))
    await act(() => result.current.undo())
    await act(() => result.current.undo())
    await act(() => result.current.undo()) // empty: no-op
    expect(result.current.canUndo).toBe(false)
    await act(() => result.current.redo())
    expect(log).toEqual(['undo b', 'undo a', 'redo a'])
    expect(result.current.canRedo).toBe(true)
    act(() => result.current.push(entry(log, 'c')))
    expect(result.current.canRedo).toBe(false)
  })

  it('drops a failed step and reports it', async () => {
    const onError = vi.fn()
    const { result } = renderHook(() => useUndoHistory(onError))
    act(() => result.current.push({ undo: async () => { throw new Error('no') }, redo: () => {} }))
    await act(() => result.current.undo())
    expect(onError).toHaveBeenCalledWith(new Error('no'))
    expect(result.current.canUndo).toBe(false)
    expect(result.current.canRedo).toBe(false)
  })

  it('ignores a step while one runs, and keeps at most HISTORY_LIMIT entries', async () => {
    const log: string[] = []
    const { result } = renderHook(() => useUndoHistory())
    let release = () => {}
    act(() => result.current.push(entry(log, 'old')))
    act(() => result.current.push({ undo: () => new Promise<void>((r) => (release = r)), redo: () => {} }))
    let first: Promise<void>
    act(() => {
      first = result.current.undo()
    })
    await act(() => result.current.undo())
    release()
    await act(() => first)
    expect(log).toEqual([])
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) act(() => result.current.push(entry(log, String(i))))
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) await act(() => result.current.undo())
    expect(log).toHaveLength(HISTORY_LIMIT)
    expect(log.at(-1)).toBe('undo 5')
  })
})

describe('historyKey', () => {
  const key = (init: KeyboardEventInit, target: EventTarget = document.body) => {
    const e = new KeyboardEvent('keydown', init)
    Object.defineProperty(e, 'target', { value: target })
    return historyKey(e)
  }
  it.each([
    [{ key: 'z', ctrlKey: true }, 'undo'],
    [{ key: 'Z', metaKey: true }, 'undo'],
    [{ key: 'z', ctrlKey: true, shiftKey: true }, 'redo'],
    [{ key: 'y', ctrlKey: true }, 'redo'],
    [{ key: 'z' }, null],
    [{ key: 'z', ctrlKey: true, altKey: true }, null],
    [{ key: 'a', ctrlKey: true }, null],
  ])('%o → %s', (init, want) => expect(key(init)).toBe(want))
  it('leaves a field its own text undo', () => {
    expect(key({ key: 'z', ctrlKey: true }, document.createElement('input'))).toBeNull()
  })
})
