'use client'
import GlobalStyles from '@mui/material/GlobalStyles'
import type { Theme } from '@mui/material/styles'
import { motion, useUiStore } from '@eerp/core-front'

// The ERP's pretty/performance switch (Settings → Global settings). Mounted only by
// the ERP layout, so these global rules exist only while an /app page is open — the
// public site never sees them. Global (not a wrapper's sx) on purpose: menus,
// dialogs and popovers portal to <body>, outside any ERP wrapper element.

const ease = motion.easing
const soft = '0 2px 8px -2px rgba(15,23,42,0.10), 0 1px 3px rgba(15,23,42,0.06)'
const lifted = '0 10px 24px -6px rgba(15,23,42,0.18), 0 4px 10px -4px rgba(15,23,42,0.10)'
const floating = '0 24px 48px -12px rgba(15,23,42,0.28)'

const pretty = {
  '@keyframes erp-enter': {
    from: { opacity: 0, transform: 'translateY(6px)' },
    to: { opacity: 1, transform: 'none' },
  },
  // Each page's content eases in on navigation (the ERP layout's content box).
  '.erp-page > *': { animation: `erp-enter 240ms ${ease} both` },
  '.MuiAppBar-root': { boxShadow: soft },
  '.MuiCard-root, .MuiPaper-outlined': {
    boxShadow: soft,
    transition: `box-shadow 200ms ${ease}`,
  },
  '.MuiCard-root:hover': { boxShadow: lifted },
  '.MuiButton-root': {
    transition: `background-color 150ms ${ease}, box-shadow 150ms ${ease}, transform 150ms ${ease}`,
  },
  '.MuiButton-contained:hover': { boxShadow: soft, transform: 'translateY(-1px)' },
  '.MuiButton-root:active': { transform: 'none' },
  '.MuiPopover-paper, .MuiMenu-paper, .MuiAutocomplete-paper': { boxShadow: lifted },
  '.MuiDialog-paper': { boxShadow: floating },
  '.MuiTableRow-root, .MuiListItemButton-root, .MuiMenuItem-root, .MuiChip-root, .MuiTab-root': {
    transition: `background-color 150ms ${ease}, color 150ms ${ease}`,
  },
}

const performance = (theme: Theme) => ({
  // Same collapse as the theme's prefers-reduced-motion rule (0.01ms, not none, so
  // anything waiting on transitionend/animationend still gets it).
  '*, *::before, *::after': {
    animationDuration: '0.01ms !important',
    animationIterationCount: '1 !important',
    transitionDuration: '0.01ms !important',
    transitionDelay: '0ms !important',
    scrollBehavior: 'auto !important',
  },
  // Focused buttons keep their focus-ring shadow (WCAG 2.4.7).
  '.MuiPaper-root, .MuiAppBar-root, .MuiButton-root:not(.Mui-focusVisible), .MuiFab-root:not(.Mui-focusVisible)': {
    boxShadow: 'none !important',
  },
  // Without shadows, floating surfaces need an edge to stand off the page.
  '.MuiPopover-paper, .MuiDialog-paper, .MuiDrawer-paper, .MuiSnackbarContent-root': {
    border: `1px solid ${theme.palette.divider}`,
  },
  '.MuiTouchRipple-root': { display: 'none' },
})

export function ErpUiStyle() {
  const uiStyle = useUiStore((s) => s.uiStyle)
  return <GlobalStyles styles={uiStyle === 'performance' ? performance : pretty} />
}
