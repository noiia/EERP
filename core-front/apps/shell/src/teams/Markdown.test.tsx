import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
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
})
