import '@testing-library/jest-dom'

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
