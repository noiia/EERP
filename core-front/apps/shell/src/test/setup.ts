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

// jsdom has no native matchMedia. MUI's useMediaQuery (AppTopBar.tsx's narrow-phone
// breadcrumb collapse) calls it on every render; without this stub any test mounting
// AppTopBar crashes with "window.matchMedia is not a function". Always reports "no
// match" (desktop-width behavior) — a narrow-width-specific test overrides this itself.
if (typeof window !== 'undefined' && typeof window.matchMedia === 'undefined') {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })
}
