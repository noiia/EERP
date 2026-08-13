'use client'
import Box from '@mui/material/Box'
import Chip from '@mui/material/Chip'
import { useT } from '../i18n/translate'
import { byPrefixAndName, FontAwesomeIcon } from './icons'
import type { FieldDescriptor } from './descriptor'

// The form-level status breadcrumb (ViewDescriptor.statusBar): a read-only
// row of chips over a declared `type: 'selection'` field's own
// `selection.options`, in declaration order — the field already owns the
// step order, so nothing here re-declares it (same "don't re-declare what a
// field already states" spirit `viewModeDefaults.kanbanStatusField` follows
// for Kanban's columns). Purely a DISPLAY of the field's current value:
// no click handlers, no way to change status from here — the field stays
// editable through its normal widget elsewhere on the form, same as before.

export interface StatusBarProps {
  field: FieldDescriptor
  /** The field's current value on the draft — re-renders live as it changes. */
  value: unknown
}

export function StatusBar({ field, value }: StatusBarProps) {
  const t = useT()
  const options = field.selection?.options ?? []
  if (options.length === 0) return null

  const currentIndex = options.indexOf(String(value))

  return (
    <Box
      component="nav"
      aria-label={t('Status')}
      sx={{ display: 'flex', alignItems: 'center', gap: 0.5, ml: 'auto' }}
    >
      {options.map((option, i) => {
        const done = currentIndex >= 0 && i < currentIndex
        const current = i === currentIndex
        return (
          <Box key={option} sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            {i > 0 && (
              <FontAwesomeIcon
                icon={byPrefixAndName.fas['chevron-right']}
                size="xs"
                style={{ opacity: 0.35 }}
              />
            )}
            <Chip
              size="small"
              label={t(option)}
              color={current ? 'primary' : done ? 'success' : 'default'}
              variant={current || done ? 'filled' : 'outlined'}
              icon={done ? <FontAwesomeIcon icon={byPrefixAndName.fas['check']} size="xs" /> : undefined}
            />
          </Box>
        )
      })}
    </Box>
  )
}
