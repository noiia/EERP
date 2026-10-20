'use client'
import { Suspense, use, type ComponentType, type ReactNode } from 'react'

// Code-splitting for the engine's heavy widgets (the data grid, the tree view, the
// rich-text editor, Graph mode's grid layout): each sits behind a dynamic import(),
// so the bundler moves it to its own chunk instead of the one every ERP page loads.
//
// Why not React.lazy: React.lazy suspends on the first render of every new
// instance even when the chunk is already loaded, and a Suspense fallback shown
// during a navigation holds the real content back ~300 ms (React's
// fallback-reveal throttle — the reason /app has no loading.tsx). Here, once the
// chunk has loaded, every render is synchronous: nothing suspends, so nothing is
// throttled. `preloadLazyComponents()` (called at idle by the ERP layout) loads
// every chunk ahead of the first page that needs it.
//
// Server rendering resolves the import on the server, so the HTML holds the real
// widget; during hydration React keeps that HTML until the chunk arrives.

export interface LazyComponent<P> {
  (props: P): ReactNode
  /** Loads the chunk; resolves once rendering no longer suspends. */
  preload(): Promise<void>
}

const registry: LazyComponent<never>[] = []

export function lazyComponent<P extends object>(
  load: () => Promise<ComponentType<P>>,
): LazyComponent<P> {
  let loaded: ComponentType<P> | undefined
  let pending: Promise<ComponentType<P>> | undefined
  const start = () =>
    (pending ??= load().then(
      (component) => (loaded = component),
      (err: unknown) => {
        // A failed chunk load (network blip) can be retried by the next render.
        pending = undefined
        throw err
      },
    ))

  function Loaded(props: P) {
    const Component = loaded ?? use(start())
    return <Component {...props} />
  }
  // The element tree is the same before and after the load (always Suspense >
  // Loaded), so the widget never remounts — and loses no state — once it arrives.
  function Lazy(props: P) {
    return (
      <Suspense fallback={null}>
        <Loaded {...props} />
      </Suspense>
    )
  }
  Lazy.preload = () => start().then(() => undefined)
  registry.push(Lazy as LazyComponent<never>)
  return Lazy
}

/** Loads every lazy component's chunk. The ERP layout calls it once the page is
 * idle, so navigating to a list, a graph or an HTML field never waits on one. */
export function preloadLazyComponents(): Promise<void> {
  return Promise.all(registry.map((c) => c.preload())).then(() => undefined)
}
