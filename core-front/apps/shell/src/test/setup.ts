import '@testing-library/jest-dom/vitest'
import { vi } from 'vitest'

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

// Outside a mounted App Router, next/navigation's useRouter throws. Links render
// through the engine's IntentLink (@eerp/core-front), which reads the router to
// prefetch on hover, so every test rendering a link needs one: this default keeps
// the real module and stubs only useRouter. A test file mocking next/navigation
// itself replaces this whole mock.
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
  }),
}))
