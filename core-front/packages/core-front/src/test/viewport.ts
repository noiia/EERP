// Test viewport: setViewportWidth sets window.innerWidth and makes window.matchMedia
// evaluate (max-width:Npx) / (min-width:Npx) against it, notifying `change` listeners.
type Listener = (e: MediaQueryListEvent) => void
const entries = new Set<{ query: string; listeners: Set<Listener> }>()

function evaluate(query: string): boolean {
  const w = window.innerWidth
  const max = /\(max-width:\s*([\d.]+)px\)/.exec(query)
  const min = /\(min-width:\s*([\d.]+)px\)/.exec(query)
  return (!max || w <= Number(max[1])) && (!min || w >= Number(min[1]))
}

export function setViewportWidth(width: number): void {
  window.innerWidth = width
  window.matchMedia = ((query: string) => {
    const entry = { query, listeners: new Set<Listener>() }
    entries.add(entry)
    return {
      get matches() { return evaluate(query) },
      media: query,
      onchange: null,
      addListener: (l: Listener | null) => { if (l) entry.listeners.add(l) },
      removeListener: (l: Listener | null) => { if (l) entry.listeners.delete(l) },
      addEventListener: (_: string, l: unknown) => entry.listeners.add(l as Listener),
      removeEventListener: (_: string, l: unknown) => entry.listeners.delete(l as Listener),
      dispatchEvent: () => false,
    }
  }) as typeof window.matchMedia
  entries.forEach((e) => e.listeners.forEach((l) => l({ matches: evaluate(e.query), media: e.query } as MediaQueryListEvent)))
  window.dispatchEvent(new Event('resize'))
}
