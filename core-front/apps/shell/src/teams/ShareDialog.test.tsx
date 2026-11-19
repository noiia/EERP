import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const setShares = vi.fn().mockResolvedValue([])
vi.mock('./client', () => ({
  directory: () => Promise.resolve([{ id: 'u1', display_name: 'Alice', email: 'a@x' }, { id: 'u2', display_name: 'Bob', email: 'b@x' }]),
  getShares: () => Promise.resolve([{ user_id: 'u1', display_name: 'Alice', email: 'a@x' }]),
  setShares: (...a: unknown[]) => setShares(...a),
}))
import { ShareDialog } from './ShareDialog'

describe('ShareDialog', () => {
  it('preselects current shares and saves the chosen ids', async () => {
    const onSaved = vi.fn()
    render(<ShareDialog open fileId="f1" onClose={vi.fn()} onSaved={onSaved} />)
    expect(await screen.findByText('Alice')).toBeInTheDocument()
    const input = screen.getByRole('combobox', { name: /share with/i })
    fireEvent.mouseDown(input)
    fireEvent.click(await screen.findByRole('option', { name: 'Bob' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(setShares).toHaveBeenCalledWith('f1', ['u1', 'u2']))
    expect(onSaved).toHaveBeenCalled()
  })
})
