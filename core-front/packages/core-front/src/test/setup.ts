import '@testing-library/jest-dom/vitest'
import { beforeAll } from 'vitest'

// jsdom has no native ResizeObserver. react-grid-layout's useContainerWidth (Graph
// mode, graph-renderer.tsx) uses one internally; graph-renderer.test.tsx mocks the
// whole module, but this stub keeps any OTHER test that mounts something
// ResizeObserver-adjacent from crashing with "ResizeObserver is not defined".
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub
}

// The heavy widgets load through dynamic import() (views/lazy-component.tsx).
// Loading their chunks before each file's tests keeps renders synchronous, as
// they are in the app once preloaded. A beforeAll, not a top-level import, so a
// test file's vi.mock calls apply to the modules these chunks pull in.
beforeAll(async () => {
  const { preloadLazyComponents } = await import('../views/lazy-component')
  await preloadLazyComponents()
})
