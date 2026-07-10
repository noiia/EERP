// Design tokens — the centralized, framework-agnostic source of truth for the visual
// system (direction "B — Surfaced": subtle depth, 8px radius, compact density). Raw
// semantic scales with NO MUI dependency, consumed by buildAppTheme to produce the live
// theme. Explicit values only — renderers reference these, never magic numbers, and the
// brand palette (palette.ts, user-editable) supplies the accent + neutral anchors.
//
// PUBLIC CONTRACT: this module is re-exported from @eerp/core-front. External modules
// MAY read these tokens, but should prefer the theme (useTheme()) so user palette edits
// flow through. Treat the named token groups below as additive, stable surface.

/**
 * Neutral ramp (Slate). The 50 / 500 / 800 stops are exactly the brand's Soft White,
 * Steel Grey, and Deep Ocean — so the neutrals are a superset of the palette, not a
 * second, competing grey. Everything structural (text, borders, surfaces) comes from here.
 */
export const neutral = {
  0: '#FFFFFF',
  50: '#F8FAFC', // == palette.softWhite
  100: '#F1F5F9',
  200: '#E2E8F0',
  300: '#CBD5E1',
  400: '#94A3B8',
  500: '#64748B', // == palette.steelGrey
  600: '#475569',
  700: '#334155',
  800: '#1E293B', // == palette.deepOcean
  900: '#0F172A',
} as const

/**
 * Status colors. Kept distinct from the brand accent and tuned so MUI's auto-contrast
 * (contrastThreshold raised to 4.5 in the theme) picks an AA-compliant text color.
 */
export const status = {
  success: '#10B981', // == palette.successGreen
  warning: '#D97706', // amber-600
  error: '#DC2626', // red-600
  info: '#0E7490', // cyan-700 (matches the AA-safe action shade)
} as const

/** Corner radii. md (8) is the default surface radius for direction B. */
export const radius = {
  sm: 6,
  md: 8,
  lg: 12,
  pill: 999,
} as const

/**
 * Elevation tier (direction B = 3 steps). Shadows are Deep-Ocean-tinted (not pure black)
 * so depth reads as "ink", calm rather than heavy. `card` for resting surfaces, `overlay`
 * for menus/popovers/dialogs, `header` for the sticky grid/app-bar hairline.
 */
export const elevation = {
  none: 'none',
  card: '0 1px 2px 0 rgba(15,23,42,0.06), 0 1px 3px 0 rgba(15,23,42,0.04)',
  overlay: '0 4px 12px -2px rgba(15,23,42,0.12), 0 2px 6px -2px rgba(15,23,42,0.08)',
  header: '0 1px 0 0 rgba(15,23,42,0.08)',
} as const

/** Font stacks. Inter if present (load via next/font in the shell), else system UI. */
export const fontFamily =
  "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
export const fontFamilyMono =
  "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"

/**
 * Type scale. Data-dense base (body 14px) with a deliberate, compressed hierarchy and
 * tight heading leading. `tabularNums` is applied to numeric data surfaces (grid cells,
 * number inputs) so figures align in columns.
 */
export const typeScale = {
  h1: { fontSize: '1.75rem', lineHeight: 1.2, fontWeight: 700, letterSpacing: '-0.01em' },
  h2: { fontSize: '1.5rem', lineHeight: 1.25, fontWeight: 700, letterSpacing: '-0.01em' },
  h3: { fontSize: '1.25rem', lineHeight: 1.3, fontWeight: 600, letterSpacing: '-0.005em' },
  h4: { fontSize: '1.125rem', lineHeight: 1.35, fontWeight: 600 },
  h5: { fontSize: '1rem', lineHeight: 1.4, fontWeight: 600 },
  h6: { fontSize: '0.875rem', lineHeight: 1.4, fontWeight: 600, letterSpacing: '0.02em' },
  subtitle1: { fontSize: '0.9375rem', lineHeight: 1.45, fontWeight: 600 },
  subtitle2: { fontSize: '0.8125rem', lineHeight: 1.45, fontWeight: 600 },
  body1: { fontSize: '0.875rem', lineHeight: 1.5 },
  body2: { fontSize: '0.8125rem', lineHeight: 1.5 },
  caption: { fontSize: '0.75rem', lineHeight: 1.4 },
} as const

/** Numeric figures align in columns; used by grid cells + number inputs. */
export const tabularNums = 'tabular-nums' as const

/**
 * Layout constants (px). The base spacing UNIT stays MUI's 8px grid — use theme.spacing(n);
 * these are the few named, non-derivable measures the renderers need.
 */
export const layout = {
  /** Max width of a single-column data-entry form. */
  formMaxWidth: 560,
  /** Max readable width for centered page content. */
  contentMaxWidth: 1280,
  /** Compact grid row height (px) for data density. */
  gridRowHeight: 40,
  gridHeaderHeight: 42,
  /** Page-content inset — applied once, around everything except the fixed top bar
   * (RootLayout), so no view (list, form, dashboard, settings) ever touches or crosses
   * the screen edge. 5% of the viewport on each axis; horizontal is the one an
   * overflowing child (e.g. Graph's canvas) must never be allowed to escape. */
  pageInsetX: '5vw',
  pageInsetY: '5vh',
  /** "Phone" boundary (px), pinned to MUI's `sm` breakpoint (600) so the CSS side
   * (`sx` breakpoint values, which keep using `xs`/`sm` directly) and the JS side can
   * never drift apart. The ONE named number for JavaScript phone-width branches —
   * components that must change their render TREE below phone width (e.g. Graph's
   * single-column projection) compare their own measured container width against this;
   * anything expressible as pure CSS uses `sx` breakpoints instead
   * (docs/roadmaps/responsive-displays.md, Architecture decisions 1–2). */
  phoneMaxWidth: 600,
} as const

/** Motion. Short, restrained; the theme also disables it under prefers-reduced-motion. */
export const motion = {
  duration: { short: 120, standard: 200 },
  easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
} as const

/** Convert a hex color to an rgba() string (used for focus rings / tints). */
export function withAlpha(hex: string, alpha: number): string {
  const h = hex.replace('#', '')
  const full =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h
  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/** A 3px focus ring in the given color — the centralized visible-focus indicator. */
export function focusRing(color: string): string {
  return `0 0 0 3px ${withAlpha(color, 0.4)}`
}
