'use client'
import { useState } from 'react'
import Button from '@mui/material/Button'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import { useT } from '@eerp/core-front'
import { BLOCK_TYPES, type BlockType } from '@/website/types'

export const BLOCK_LABELS: Record<BlockType, string> = {
  text: 'Text',
  image: 'Image',
  hero: 'Hero',
  record_list: 'Record list',
  record_detail: 'Record detail',
  record_carousel: 'Record carousel',
  event_booking: 'Event booking',
  appointment_booking: 'Appointment booking',
}

export function BlockPalette({ onAdd }: { onAdd: (type: BlockType) => void }) {
  const t = useT()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  return (
    <>
      <Button variant="outlined" onClick={(e) => setAnchor(e.currentTarget)}>{t('Add block')}</Button>
      <Menu anchorEl={anchor} open={anchor != null} onClose={() => setAnchor(null)}>
        {BLOCK_TYPES.map((type) => (
          <MenuItem key={type} onClick={() => { setAnchor(null); onAdd(type) }}>{t(BLOCK_LABELS[type])}</MenuItem>
        ))}
      </Menu>
    </>
  )
}
