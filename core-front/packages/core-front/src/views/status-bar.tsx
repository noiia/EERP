'use client'
import { useState } from 'react'
import Box from '@mui/material/Box'
import Chip from '@mui/material/Chip'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import { useT } from '../i18n/translate'
import { byPrefixAndName, FontAwesomeIcon } from './icons'
import { layout } from './tokens'
import type { FieldDescriptor } from './descriptor'

const mobileMediaQuery = `@media (min-width:${layout.mobileBreakpoint}px)` as const

// The form-level status breadcrumb (ViewDescriptor.statusBar): a row of
// chips over a selection field's steps — by default the field's own
// `selection.options`, in declaration order, or the admin's chosen subset
// (api/status-bar-config.ts). A display of the field's current value; with
// `onSelect` (StatusBarDescriptor.editable) each other step is also a button
// that picks it — the breadcrumb is then the field's only widget — and the
// current step opens a menu of every step: below the mobile breakpoint the
// current step is the only one shown, so the menu is how a phone changes it.

export interface StatusBarProps {
  field: FieldDescriptor
  /** The field's current value on the draft — re-renders live as it changes. */
  value: unknown
  /** The steps to show, in order; omitted = every option of the field. */
  steps?: string[]
  /** Makes the steps clickable: called with the picked option. */
  onSelect?: (option: string) => void
  /** Keeps clickable steps visible but inert (e.g. while saving). */
  disabled?: boolean
}

export function StatusBar({ field, value, steps, onSelect, disabled }: StatusBarProps) {
  const t = useT()
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null)
  const options = field.selection?.options ?? []
  const shown = steps ?? options
  if (shown.length === 0) return null

  // A real value the step list leaves out still shows, last, so the record's
  // status is never invisible — a value the field doesn't know isn't shown.
  const current = String(value ?? '')
  const items = options.includes(current) && !shown.includes(current) ? [...shown, current] : shown
  const currentIndex = items.indexOf(current)

  return (
    <Box
      component="nav"
      aria-label={t('Status')}
      sx={{ display: 'flex', alignItems: 'center', gap: 0.5, ml: 'auto' }}
    >
      {items.map((option, i) => {
        const done = currentIndex >= 0 && i < currentIndex
        const isCurrent = i === currentIndex
        const clickable = onSelect && !isCurrent
        return (
          <Box
            key={option}
            sx={{
              // Below layout.mobileBreakpoint, only the CURRENT step earns
              // screen space — the rest (done/upcoming) hide entirely rather
              // than crowd a narrow toolbar; at/above it every step shows.
              display: isCurrent ? 'flex' : 'none',
              [mobileMediaQuery]: { display: 'flex' },
              alignItems: 'center',
              gap: 0.5,
            }}
          >
            {i > 0 && (
              // Hidden below mobileBreakpoint too — a lone chevron with no
              // visible step before it (every earlier one is display:none)
              // would read as a stray rendering glitch, not a separator.
              <Box component="span" sx={{ display: 'none', [mobileMediaQuery]: { display: 'inline-flex' } }}>
                <FontAwesomeIcon
                  icon={byPrefixAndName.fas['chevron-right']}
                  size="xs"
                  style={{ opacity: 0.35 }}
                />
              </Box>
            )}
            <Chip
              size="small"
              label={t(option)}
              color={isCurrent ? 'primary' : done ? 'success' : 'default'}
              variant={isCurrent || done ? 'filled' : 'outlined'}
              icon={done ? <FontAwesomeIcon icon={byPrefixAndName.fas['check']} size="xs" /> : undefined}
              aria-current={isCurrent ? 'step' : undefined}
              aria-haspopup={onSelect && isCurrent ? 'menu' : undefined}
              onClick={
                clickable
                  ? () => onSelect(option)
                  : onSelect && isCurrent
                    ? (e: React.MouseEvent<HTMLElement>) => setMenuAnchor(e.currentTarget)
                    : undefined
              }
              disabled={onSelect ? disabled : undefined}
            />
          </Box>
        )
      })}
      {onSelect && (
        <Menu anchorEl={menuAnchor} open={menuAnchor !== null} onClose={() => setMenuAnchor(null)}>
          {items.map((option) => (
            <MenuItem
              key={option}
              selected={option === current}
              onClick={() => {
                setMenuAnchor(null)
                if (option !== current) onSelect(option)
              }}
            >
              {t(option)}
            </MenuItem>
          ))}
        </Menu>
      )}
    </Box>
  )
}
