import { describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { lazyComponent } from './lazy-component'

function Greeting({ name }: { name: string }) {
  const [count, setCount] = useState(0)
  return (
    <button type="button" onClick={() => setCount((c) => c + 1)}>
      {name} {count}
    </button>
  )
}

describe('lazyComponent', () => {
  it('renders nothing until its chunk loads, then the component', async () => {
    let resolve: (c: typeof Greeting) => void = () => {}
    const Lazy = lazyComponent(() => new Promise<typeof Greeting>((r) => (resolve = r)))
    // A suspending render must happen inside an awaited act() in tests.
    await act(async () => {
      render(<Lazy name="Ada" />)
    })
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    // Revealed after React's fallback-reveal throttle (~300 ms).
    await act(async () => {
      resolve(Greeting)
      await new Promise((r) => setTimeout(r, 400))
    })
    expect(screen.getByRole('button')).toHaveTextContent('Ada 0')
  })

  it('renders synchronously once preloaded', async () => {
    const Lazy = lazyComponent(() => Promise.resolve(Greeting))
    await Lazy.preload()
    render(<Lazy name="Ada" />)
    expect(screen.getByRole('button')).toHaveTextContent('Ada 0')
  })

  it('keeps the component mounted, with its state, across re-renders', async () => {
    const Lazy = lazyComponent(() => Promise.resolve(Greeting))
    let rerender: ReturnType<typeof render>['rerender'] = () => {}
    await act(async () => {
      rerender = render(<Lazy name="Ada" />).rerender
    })
    act(() => screen.getByRole('button').click())
    rerender(<Lazy name="Grace" />)
    expect(screen.getByRole('button')).toHaveTextContent('Grace 1')
  })

  it('loads the chunk once, and retries after a failed load', async () => {
    const load = vi
      .fn<() => Promise<typeof Greeting>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(Greeting)
    const Lazy = lazyComponent(load)
    await expect(Lazy.preload()).rejects.toThrow('offline')
    await Lazy.preload()
    await Lazy.preload()
    expect(load).toHaveBeenCalledTimes(2)
  })
})
