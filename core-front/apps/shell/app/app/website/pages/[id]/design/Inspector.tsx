'use client'
import type { ReactNode } from 'react'
import Box from '@mui/material/Box'
import IconButton from '@mui/material/IconButton'
import Stack from '@mui/material/Stack'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import { byPrefixAndName, FontAwesomeIcon, useT } from '@eerp/core-front'

// The page editor's settings panel pieces, shared by the page and block panels and the
// form block's settings so every panel reads the same: a header naming what is being
// edited, then titled groups of settings separated by a hairline.

/** The panel's header: what is selected (icon, name, a caption telling it apart) and a close button. */
export function InspectorHeader({ icon, title, caption, onClose }: { icon: ReactNode; title: string; caption?: string; onClose?: () => void }) {
  const t = useT()
  return (
    <Stack direction="row" spacing={1.25} sx={{
      alignItems: 'center', px: 2, py: 1.25, borderBottom: 1, borderColor: 'divider',
      position: 'sticky', top: 0, zIndex: 1, bgcolor: 'background.paper',
    }}>
      <Box aria-hidden sx={{
        width: 28, height: 28, borderRadius: 1, display: 'grid', placeItems: 'center', flexShrink: 0,
        bgcolor: 'action.selected', color: 'primary.main', fontSize: 13,
      }}>{icon}</Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="subtitle1" component="h2" noWrap>{title}</Typography>
        {caption && <Typography variant="caption" color="text.secondary" noWrap component="div">{caption}</Typography>}
      </Box>
      {onClose && (
        <Tooltip title={t('Close (Esc)')}>
          <IconButton size="small" aria-label={t('Close')} onClick={onClose}><FontAwesomeIcon icon={byPrefixAndName.fas.xmark} /></IconButton>
        </Tooltip>
      )}
    </Stack>
  )
}

/** A titled group of settings. The first group of a panel carries no rule above it. */
export function InspectorSection({ title, hint, children }: { title?: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <Stack spacing={1.5} sx={{ '& + &': { borderTop: 1, borderColor: 'divider', pt: 2 } }}>
      {(title || hint) && (
        <Box>
          {title && <Typography variant="subtitle2" component="h3">{title}</Typography>}
          {hint && <Typography variant="caption" color="text.secondary" component="div">{hint}</Typography>}
        </Box>
      )}
      {children}
    </Stack>
  )
}
