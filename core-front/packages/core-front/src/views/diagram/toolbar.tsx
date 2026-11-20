'use client'
import { useState, type MouseEvent } from 'react'
import Button, { type ButtonProps } from '@mui/material/Button'
import IconButton from '@mui/material/IconButton'
import ListItemIcon from '@mui/material/ListItemIcon'
import ListItemText from '@mui/material/ListItemText'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import { useT } from '../../i18n/translate'
import { usePhone } from '../use-phone'
import { byPrefixAndName, FontAwesomeIcon } from '../icons'

// Toolbar buttons of the diagram views: an icon beside the label, the icon alone on a phone
// (the label stays the accessible name and the tooltip).

const TOUCH = { minWidth: 40, minHeight: 40 }

type ToolButtonProps = Omit<ButtonProps, 'children' | 'startIcon'> & { icon: string; label: string }

export function ToolButton({ icon, label, size = 'small', ...rest }: ToolButtonProps) {
  const phone = usePhone()
  const glyph = <FontAwesomeIcon icon={byPrefixAndName.fas[icon]} />
  if (phone) {
    const { onClick, disabled } = rest
    return (
      <IconButton size={size} aria-label={label} title={label} aria-pressed={rest['aria-pressed']} aria-haspopup={rest['aria-haspopup']} disabled={disabled} onClick={onClick} sx={TOUCH}>
        {glyph}
      </IconButton>
    )
  }
  return (
    <Button size={size} startIcon={glyph} {...rest}>
      {label}
    </Button>
  )
}

export interface ExportOption {
  key: string
  label: string
  icon: string
  /** A click action, or `href` for a plain download link. */
  onClick?: () => void
  href?: string
}

/** One "Export" button opening the export methods as a menu. */
export function ExportMenu({ options, disabled }: { options: ExportOption[]; disabled?: boolean }) {
  const t = useT()
  const phone = usePhone()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const open = (e: MouseEvent<HTMLElement>) => setAnchor(e.currentTarget)
  const label = t('Export')
  const glyph = <FontAwesomeIcon icon={byPrefixAndName.fas['download']} />
  return (
    <>
      {phone ? (
        <IconButton size="small" aria-label={label} title={label} aria-haspopup="menu" disabled={disabled} onClick={open} sx={TOUCH}>
          {glyph}
        </IconButton>
      ) : (
        <Button size="small" aria-haspopup="menu" disabled={disabled} onClick={open} startIcon={glyph} endIcon={<FontAwesomeIcon icon={byPrefixAndName.fas['chevron-down']} style={{ fontSize: 10 }} />}>
          {label}
        </Button>
      )}
      <Menu open={!!anchor} anchorEl={anchor} onClose={() => setAnchor(null)}>
        {options.map((o) => (
          <MenuItem
            key={o.key}
            {...(o.href ? { component: 'a', href: o.href, download: true } : {})}
            onClick={() => {
              setAnchor(null)
              o.onClick?.()
            }}
          >
            <ListItemIcon>
              <FontAwesomeIcon icon={byPrefixAndName.fas[o.icon]} />
            </ListItemIcon>
            <ListItemText>{o.label}</ListItemText>
          </MenuItem>
        ))}
      </Menu>
    </>
  )
}
