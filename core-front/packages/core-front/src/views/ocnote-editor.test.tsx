import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { OcNoteEditor, parseOcNote } from './ocnote-editor'

Range.prototype.getClientRects ??= () => document.body.getClientRects()
Range.prototype.getBoundingClientRect ??= () => document.body.getBoundingClientRect()

// The bare JSON shape and rich extensions used by OpenCloud's tiptapJson strategy.
const note = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      attrs: { textAlign: 'center' },
      content: [
        {
          type: 'text',
          text: 'Bonjour',
          marks: [
            { type: 'bold' },
            {
              type: 'textStyle',
              attrs: {
                color: '#ff0000',
                backgroundColor: '#ffff00',
                fontFamily: 'serif',
                fontSize: '18px',
                lineHeight: '1.5',
              },
            },
          ],
        },
        { type: 'text', text: '2', marks: [{ type: 'superscript' }] },
      ],
    },
    {
      type: 'taskList',
      content: [
        {
          type: 'taskItem',
          attrs: { checked: true },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Done' }] }],
        },
      ],
    },
    {
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            {
              type: 'tableCell',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Cell' }] }],
            },
          ],
        },
      ],
    },
    {
      type: 'image',
      attrs: { src: 'https://example.com/image.png', alt: 'Example', width: 200, height: 100 },
    },
    {
      type: 'codeBlock',
      attrs: { language: 'javascript' },
      content: [{ type: 'text', text: 'const x = 1' }],
    },
    {
      type: 'heading',
      attrs: { level: 2, id: 'heading-id', 'data-toc-id': 'toc-id' },
      content: [{ type: 'text', text: 'Section' }],
    },
  ],
}

describe('OpenCloud notes', () => {
  it('accepts the OpenCloud schema, including rich formatting, tasks, tables and images', () => {
    expect(parseOcNote(JSON.stringify(note))).toEqual(note)
    expect(parseOcNote('')).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] })
  })

  it.each(['not json', '<p>HTML</p>', 'null', '{}', '[]', '{"type":"doc","content":"text"}'])(
    'rejects an invalid document: %s',
    (value) => {
      expect(() => parseOcNote(value)).toThrow()
    },
  )

  it.each([
    { type: 'futureBlock' },
    { type: 'paragraph', attrs: { futureFormatting: 'keep me' } },
    { type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'futureMark' }] }] },
  ])('refuses unsupported formatting instead of discarding it', (node) => {
    expect(() => parseOcNote(JSON.stringify({ type: 'doc', content: [node] }))).toThrow(
      /formatting/,
    )
  })

  it('renders notes read-only and preserves their rich formatting when editing', async () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <OcNoteEditor value={JSON.stringify(note)} onChange={onChange} disabled />,
    )
    const text = await screen.findByText('Bonjour')
    expect(text.closest('[contenteditable]')).toHaveAttribute('contenteditable', 'false')
    expect(text.closest('strong')).not.toBeNull()
    expect(screen.getByText('Cell').closest('table')).not.toBeNull()
    expect(screen.getByRole('checkbox')).toBeChecked()
    expect(screen.queryByRole('button', { name: 'Bold' })).toBeNull()
    rerender(<OcNoteEditor value={JSON.stringify(note)} onChange={onChange} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Text style' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Heading 2' }))
    await waitFor(() => expect(onChange).toHaveBeenCalled())
    const saved = JSON.parse(onChange.mock.calls.at(-1)![0])
    expect(saved.type).toBe('doc')
    expect(saved.content[0].content[0].marks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'textStyle',
          attrs: expect.objectContaining({ color: '#ff0000', fontSize: '18px', lineHeight: '1.5' }),
        }),
      ]),
    )
    expect(saved.content.find((n: { type: string }) => n.type === 'image').attrs).toMatchObject({
      width: 200,
      height: 100,
    })
    expect(saved.content.find((n: { type: string }) => n.type === 'codeBlock').attrs.language).toBe(
      'javascript',
    )
    expect(
      saved.content.find(
        (n: { type: string; attrs?: { id?: string } }) => n.attrs?.id === 'heading-id',
      ).attrs,
    ).toMatchObject({ id: 'heading-id', 'data-toc-id': 'toc-id' })
    expect(() => parseOcNote(JSON.stringify(saved))).not.toThrow()
  })

  it('reports invalid files and blocks editing', async () => {
    const valid = vi.fn()
    render(<OcNoteEditor value="broken" onChange={vi.fn()} onValidityChange={valid} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid note file.')
    expect(screen.queryByRole('button', { name: 'Bold' })).toBeNull()
    expect(valid).toHaveBeenLastCalledWith(false)
  })

  it('shows every toolbar icon and provides zoom without changing the document', async () => {
    const onChange = vi.fn()
    render(<OcNoteEditor value={JSON.stringify(note)} onChange={onChange} />)
    const toolbar = await screen.findByRole('toolbar', { name: 'Document tools' })
    for (const button of within(toolbar).getAllByRole('button')) {
      if (!button.textContent?.trim()) expect(button.querySelector('svg')).not.toBeNull()
    }
    fireEvent.click(screen.getByRole('button', { name: 'Zoom' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '125%' }))
    expect(screen.getByTestId('ocnote-document')).toHaveStyle({ zoom: '1.25' })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('inserts and edits a table through the grid and table commands', async () => {
    const onChange = vi.fn()
    render(<OcNoteEditor value="" onChange={onChange} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Insert table' }))
    fireEvent.click(await screen.findByRole('button', { name: '3 × 2' }))
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    const saved = () =>
      JSON.parse(onChange.mock.calls.at(-1)![0]).content.find(
        (node: { type: string }) => node.type === 'table',
      )
    await waitFor(() => expect(saved().content).toHaveLength(2))
    expect(saved().content[0].content).toHaveLength(3)
    fireEvent.click(screen.getByRole('button', { name: 'Insert table' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add row below' }))
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    await waitFor(() => expect(saved().content).toHaveLength(3))
    fireEvent.click(screen.getByRole('button', { name: 'Insert table' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete column' }))
    await waitFor(() => expect(saved().content[0].content).toHaveLength(2))
  })

  it('finds text across formatting, filters whole words, and replaces matches', async () => {
    const onChange = vi.fn()
    const value = JSON.stringify({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'hello ' },
            { type: 'text', text: 'Hello', marks: [{ type: 'bold' }] },
            { type: 'text', text: ' helloWorld' },
          ],
        },
      ],
    })
    render(<OcNoteEditor value={value} onChange={onChange} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Find and replace' }))
    fireEvent.change(screen.getByLabelText('Find in document'), { target: { value: 'hello' } })
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('1 / 3'))
    fireEvent.click(screen.getByRole('button', { name: 'Whole words' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('1 / 2'))
    fireEvent.click(screen.getByRole('button', { name: 'Match case' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('1 / 1'))
    fireEvent.change(screen.getByLabelText('Replace with'), { target: { value: 'Bonjour' } })
    fireEvent.click(screen.getByRole('button', { name: 'Replace all' }))
    await waitFor(() => expect(onChange).toHaveBeenCalled())
    expect(onChange.mock.calls.at(-1)![0]).toContain('Bonjour')
    expect(onChange.mock.calls.at(-1)![0]).toContain('helloWorld')
    expect(onChange.mock.calls.at(-1)![0]).toContain('Hello')
  })

  it('offers the outline and find tools in read-only mode without replacement', async () => {
    render(<OcNoteEditor value={JSON.stringify(note)} onChange={vi.fn()} disabled />)
    fireEvent.click(await screen.findByRole('button', { name: 'Document outline' }))
    const outline = screen.getByRole('complementary', { name: 'Document outline' })
    expect(within(outline).getByRole('button', { name: 'Section' })).toBeInTheDocument()
    fireEvent.click(within(outline).getByRole('button', { name: 'Section' }))
    expect(within(outline).getByRole('button', { name: 'Section' })).toHaveAttribute(
      'aria-current',
      'location',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Find and replace' }))
    expect(screen.getByLabelText('Find in document')).toBeInTheDocument()
    expect(screen.queryByLabelText('Replace with')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Bold' })).toBeNull()
  })

  it('inserts a link through its dialog and refuses a script URL', async () => {
    const onChange = vi.fn()
    render(<OcNoteEditor value="" onChange={onChange} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Link' }))
    fireEvent.change(screen.getByLabelText('Link address'), {
      target: { value: 'javascript:alert(1)' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Insert' }))
    expect(screen.getByText('Enter a valid address.')).toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Link address'), {
      target: { value: 'https://example.com' },
    })
    fireEvent.change(screen.getByLabelText('Link text'), { target: { value: 'Documentation' } })
    fireEvent.click(screen.getByRole('button', { name: 'Insert' }))
    await waitFor(() => expect(onChange).toHaveBeenCalled())
    expect(onChange.mock.calls.at(-1)![0]).toContain('Documentation')
    expect(onChange.mock.calls.at(-1)![0]).toContain('https://example.com')
  })

  it('renders imported text and links without executing embedded HTML or script URLs', async () => {
    const value = JSON.stringify({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '<img src=x onerror=alert(1)>' },
            {
              type: 'text',
              text: 'Unsafe link',
              marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
            },
          ],
        },
      ],
    })
    const { container } = render(<OcNoteEditor value={value} onChange={vi.fn()} disabled />)
    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeInTheDocument()
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull()
  })
})
