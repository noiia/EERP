'use client'
import { useState } from 'react'
import Button from '@mui/material/Button'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import ListItemIcon from '@mui/material/ListItemIcon'
import { FontAwesomeIcon, byPrefixAndName, useT } from '@eerp/core-front'
import { BLOCK_TYPES, type BlockType } from '@/website/types'

export const BLOCK_LABELS: Record<BlockType, string> = {
  text: 'Text',
  image: 'Image',
  hero: 'Hero',
  record_list: 'Record list',
  record_detail: 'Record detail',
  record_carousel: 'Record carousel',
  image_carousel: 'Image carousel',
  event_booking: 'Event booking',
  appointment_booking: 'Appointment booking',
  event_list: 'Event list',
  section: 'Background section',
  form: 'Form',
}

// Icon names resolved through `byPrefixAndName.fas` (see packages/core-front/src/views/icons.ts).
export const BLOCK_ICONS: Record<BlockType, string> = {
  text: 'align-left',
  image: 'image',
  hero: 'panorama',
  record_list: 'list',
  record_detail: 'file-lines',
  record_carousel: 'table-cells-large',
  image_carousel: 'images',
  event_booking: 'calendar-check',
  appointment_booking: 'clock',
  event_list: 'calendar-days',
  section: 'square',
  form: 'rectangle-list',
}

export function BlockPalette({ onAdd }: { onAdd: (type: BlockType) => void }) {
  const t = useT()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  return (
    <>
      <Button variant="outlined" onClick={(e) => setAnchor(e.currentTarget)}>{t('Add block')}</Button>
      <Menu anchorEl={anchor} open={anchor != null} onClose={() => setAnchor(null)}>
        {BLOCK_TYPES.map((type) => (
          <MenuItem key={type} onClick={() => { setAnchor(null); onAdd(type) }}>
            <ListItemIcon><FontAwesomeIcon icon={byPrefixAndName.fas[BLOCK_ICONS[type]]} /></ListItemIcon>
            {t(BLOCK_LABELS[type])}
          </MenuItem>
        ))}
      </Menu>
    </>
  )
}
