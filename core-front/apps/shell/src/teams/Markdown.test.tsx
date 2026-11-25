import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Markdown } from './Markdown'

describe('Markdown', () => {
  it('renders the formatting panel patterns', () => {
    const { container } = render(
      <Markdown text={'## Plan\n**bold** *it* ~~old~~ `x`\n> quoted\n- a\n- b\n1. one\n```\nraw **not bold**\n```\n[docs](https://example.com)'} />,
    )
    expect(screen.getByText('Plan')).toBeInTheDocument()
    expect(container.querySelector('strong')).toHaveTextContent('bold')
    expect(container.querySelector('em')).toHaveTextContent('it')
    expect(container.querySelector('s')).toHaveTextContent('old')
    expect(container.querySelector('code')).toHaveTextContent('x')
    expect(container.querySelector('blockquote')).toHaveTextContent('quoted')
    expect(container.querySelectorAll('ul li')).toHaveLength(2)
    expect(container.querySelectorAll('ol li')).toHaveLength(1)
    expect(container.querySelector('pre')).toHaveTextContent('raw **not bold**')
    expect(screen.getByRole('link', { name: 'docs' })).toHaveAttribute('href', 'https://example.com')
  })

  it('never renders HTML or unsafe links', () => {
    const { container } = render(<Markdown text={'<b>hi</b> [x](javascript:alert(1)) a*b'} />)
    expect(container.querySelector('b')).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
    expect(container).toHaveTextContent('<b>hi</b> [x](javascript:alert(1)) a*b')
  })

  it('links bare URLs, opened only with Ctrl/Cmd+click', () => {
    render(<Markdown text={'see https://example.com/a?b=1. and `http://not.linked`'} />)
    const link = screen.getByRole('link', { name: 'https://example.com/a?b=1' })
    expect(link).toHaveAttribute('href', 'https://example.com/a?b=1')
    expect(fireEvent.click(link)).toBe(false) // default prevented
    expect(fireEvent.click(link, { ctrlKey: true })).toBe(true)
    expect(screen.getAllByRole('link')).toHaveLength(1)
  })
  it('draws checkboxes, numbered past code blocks, clickable only with onToggle', () => {
    const toggle = vi.fn()
    render(<Markdown text={'- [ ] a\n```\n- [ ] in code\n```\n* [X] **b**'} onToggle={toggle} />)
    const boxes = screen.getAllByRole('checkbox')
    expect(boxes).toHaveLength(2)
    expect(boxes[1]).toBeChecked()
    fireEvent.click(boxes[1])
    expect(toggle).toHaveBeenCalledWith(1, false)
    fireEvent.click(boxes[0])
    expect(toggle).toHaveBeenCalledWith(0, true)
    expect(screen.getByText('b').tagName).toBe('STRONG')
  })

  it('without onToggle the checkboxes are read-only', () => {
    render(<Markdown text={'- [ ] a'} />)
    expect(screen.getByRole('checkbox')).toBeDisabled()
  })
})
