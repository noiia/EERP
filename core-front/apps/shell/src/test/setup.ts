import '@testing-library/jest-dom'

// jsdom has no native ResizeObserver. react-grid-layout's useContainerWidth (Graph
// mode, @eerp/core-front's graph-renderer.tsx) uses one internally; this stub keeps
// any test that mounts something ResizeObserver-adjacent from crashing with
// "ResizeObserver is not defined".
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub
}
