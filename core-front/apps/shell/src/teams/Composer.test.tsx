import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Composer } from './Composer'

const members = [
  { user_id: 'a', display_name: 'Alice' },
  { user_id: 'b', display_name: 'Bob' },
]
const box = () => screen.getByRole('textbox', { name: /message/i })
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
})
