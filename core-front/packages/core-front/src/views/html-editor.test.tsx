import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { HtmlEditor } from './html-editor'
import { resolveWidget, type FieldDescriptor } from './descriptor'

// jsdom has no layout, and its Range lacks the rect methods ProseMirror's
// scrollIntoView measures with — an insert's deferred scroll otherwise throws
// an unhandled error after the test, failing the run at random.
Range.prototype.getClientRects ??= () => document.body.getClientRects()
Range.prototype.getBoundingClientRect ??= () => document.body.getBoundingClientRect()

describe('HtmlEditor', () => {
  it('renders the given HTML', async () => {
    render(<HtmlEditor value="<p>Hello <strong>Ann</strong></p>" onChange={() => {}} />)
    expect(await screen.findByText('Ann')).toBeTruthy()
    expect(screen.getByText('Ann').tagName).toBe('STRONG')
  })

  it('inserts a placeholder chip into the content', async () => {
    const onChange = vi.fn()
    render(<HtmlEditor value="<p>Hi</p>" onChange={onChange} insertions={['{{name}}']} />)
    await screen.findByText('Hi')
    fireEvent.click(screen.getByRole('button', { name: '{{name}}' }))
    await waitFor(() => expect(onChange).toHaveBeenCalled())
    expect(String(onChange.mock.calls.at(-1)![0])).toContain('{{name}}')
  })

  it('follows a new value from outside (another template picked)', async () => {
    const { rerender } = render(<HtmlEditor value="<p>One</p>" onChange={() => {}} />)
    await screen.findByText('One')
    rerender(<HtmlEditor value="<p>Two</p>" onChange={() => {}} />)
    expect(await screen.findByText('Two')).toBeTruthy()
  })

  it('is read-only when disabled', async () => {
    render(<HtmlEditor value="<p>Locked</p>" onChange={() => {}} disabled />)
    const text = await screen.findByText('Locked')
    expect(text.closest('[contenteditable]')?.getAttribute('contenteditable')).toBe('false')
    expect((screen.getByRole('button', { name: /bold/i }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('text/html widget', () => {
  it('is a valid text widget', () => {
    const field: FieldDescriptor = { name: 'body', label: 'Body', type: 'text', widget: 'html' }
    expect(resolveWidget(field)).toBe('html')
  })
})
