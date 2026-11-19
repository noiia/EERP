import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ImageCarousel } from './ImageCarousel'

const images = [
  { src: '/a.png', alt: 'A' },
  { src: '/b.png', alt: 'B' },
  { src: '/c.png', alt: 'C' },
]

function swipe(el: Element, dx: number) {
  fireEvent.pointerDown(el, { pointerId: 1, clientX: 200, clientY: 100, pointerType: 'touch' })
  fireEvent.pointerMove(el, { pointerId: 1, clientX: 200 + dx, clientY: 102, pointerType: 'touch' })
  fireEvent.pointerUp(el, { pointerId: 1, clientX: 200 + dx, clientY: 102, pointerType: 'touch' })
}

describe('ImageCarousel swipe', () => {
  it('moves to the next picture on a left swipe and back on a right one', () => {
    render(<ImageCarousel images={images} />)
    const frame = screen.getByRole('img', { name: 'A' }).parentElement!
    swipe(frame, -120)
    expect(screen.getByRole('img', { name: 'B' })).toBeInTheDocument()
    swipe(frame, 120)
    expect(screen.getByRole('img', { name: 'A' })).toBeInTheDocument()
  })

  it('wraps around backwards from the first picture', () => {
    render(<ImageCarousel images={images} />)
    swipe(screen.getByRole('img', { name: 'A' }).parentElement!, 120)
    expect(screen.getByRole('img', { name: 'C' })).toBeInTheDocument()
  })

  it('ignores a short or vertical move', () => {
    render(<ImageCarousel images={images} />)
    const frame = screen.getByRole('img', { name: 'A' }).parentElement!
    swipe(frame, -20)
    fireEvent.pointerDown(frame, { pointerId: 2, clientX: 200, clientY: 100 })
    fireEvent.pointerMove(frame, { pointerId: 2, clientX: 190, clientY: 300 })
    fireEvent.pointerUp(frame, { pointerId: 2, clientX: 190, clientY: 300 })
    expect(screen.getByRole('img', { name: 'A' })).toBeInTheDocument()
  })
})

describe('ImageCarousel preloading', () => {
  it('renders the previous and next pictures beside the current one, hidden from assistive tech', () => {
    const { container } = render(<ImageCarousel images={images} />)
    const srcs = [...container.querySelectorAll('img')].map((i) => i.getAttribute('src'))
    expect(srcs).toEqual(['/c.png', '/a.png', '/b.png'])
    expect(container.querySelectorAll('img[aria-hidden="true"]')).toHaveLength(2)
  })

  it('renders no neighbours for a single picture', () => {
    const { container } = render(<ImageCarousel images={[images[0]]} />)
    expect(container.querySelectorAll('img')).toHaveLength(1)
  })
})
