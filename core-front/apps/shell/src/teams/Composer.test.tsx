import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Composer, PATTERNS, applyPattern } from './Composer'

const members = [
  { user_id: 'a', display_name: 'Alice' },
  { user_id: 'b', display_name: 'Bob' },
]
const box = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: /message/i })
const type = (value: string) => fireEvent.change(box(), { target: { value } })

describe('Composer', () => {
  it('lists matching members on @ and inserts the picked one as a mention', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined)
    render(<Composer members={members} canAttach onSend={onSend} />)
    type('hi @al')
    expect(screen.getByRole('option', { name: 'Alice' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Bob' })).toBeNull()
    fireEvent.click(screen.getByRole('option', { name: 'Alice' }))
    expect(box()).toHaveValue('hi @Alice ')
    fireEvent.keyDown(box(), { key: 'Enter' })
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('hi @Alice', ['a'], []))
    await waitFor(() => expect(box()).toHaveValue(''))
  })

  it('drops a mention whose text was deleted before sending', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined)
    render(<Composer members={members} canAttach onSend={onSend} />)
    type('@b')
    fireEvent.click(screen.getByRole('option', { name: 'Bob' }))
    type('never mind')
    fireEvent.keyDown(box(), { key: 'Enter' })
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('never mind', [], []))
  })

  it('Shift+Enter does not send', () => {
    const onSend = vi.fn().mockResolvedValue(undefined)
    render(<Composer members={members} canAttach onSend={onSend} />)
    type('line')
    fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('shows the attach button only when canAttach', () => {
    const { rerender } = render(<Composer members={members} canAttach onSend={vi.fn()} />)
    expect(screen.getByRole('button', { name: /attach/i })).toBeInTheDocument()
    rerender(<Composer members={members} canAttach={false} onSend={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /attach/i })).toBeNull()
  })

  it('is replaced by a read-only notice for a guest', () => {
    render(<Composer members={members} canAttach readOnly onSend={vi.fn()} />)
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByText(/read only/i)).toBeInTheDocument()
  })

  it('sends picked files and lets one be removed first', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined)
    const { container } = render(<Composer members={members} canAttach onSend={onSend} />)
    const a = new File(['a'], 'a.txt')
    const b = new File(['b'], 'b.txt')
    fireEvent.change(container.querySelector('input[type=file]')!, { target: { files: [a, b] } })
    fireEvent.click(screen.getByText('a.txt').parentElement!.querySelector('svg')!)
    fireEvent.click(screen.getByRole('button', { name: /send/i }))
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('', [], [b]))
  })

  it('shows the error when sending fails and keeps the text', async () => {
    render(<Composer members={members} canAttach onSend={vi.fn().mockRejectedValue(new Error('Too long'))} />)
    type('hello')
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(await screen.findByText('Too long')).toBeInTheDocument()
    expect(box()).toHaveValue('hello')
  })

  it('opens the formatting panel, grows the box and wraps the selection with a pattern', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined)
    render(<Composer members={members} canAttach onSend={onSend} />)
    expect(screen.queryByRole('toolbar', { name: /formatting/i })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /format text/i }))
    expect(screen.getByRole('button', { name: /format text/i })).toHaveAttribute('aria-pressed', 'true')
    expect(box()).toHaveAttribute('placeholder', 'Write a message (Ctrl+Enter to send)')
    type('say hi now')
    box().setSelectionRange(4, 6)
    fireEvent.click(screen.getByRole('button', { name: 'Bold' }))
    expect(box()).toHaveValue('say **hi** now')
    expect([box().selectionStart, box().selectionEnd]).toEqual([6, 8])
    // Enter is a new line while formatting; Ctrl+Enter sends.
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true })
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('say **hi** now', [], []))
  })
})

describe('applyPattern', () => {
  const p = (title: string) => PATTERNS.find((x) => x.title === title)!
  it.each([
    ['Italic', 'ab', 1, 1, 'a**b', [2, 2]],
    ['Title', 'one\ntwo', 5, 5, 'one\n## two', [8, 8]],
    ['Numbered list', 'a\nb', 0, 3, '1. a\n2. b', [3, 9]],
    ['Code block', 'x', 0, 1, '```\nx\n```', [4, 5]],
    ['Link', 'site', 0, 4, '[site](https://)', [1, 5]],
  ] as const)('%s', (title, text, start, end, want, sel) => {
    const r = applyPattern(text, start, end, p(title))
    expect(r.text).toBe(want)
    expect([r.start, r.end]).toEqual(sel)
  })
})
