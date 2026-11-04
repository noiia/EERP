'use client'
import { Fragment, useState } from 'react'
import Button from '@mui/material/Button'
import ListItemIcon from '@mui/material/ListItemIcon'
import ListItemText from '@mui/material/ListItemText'
import ListSubheader from '@mui/material/ListSubheader'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import { FontAwesomeIcon, byPrefixAndName, useT } from '@eerp/core-front'
import { BLOCK_TYPES, type Block, type BlockType } from '@/website/types'

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

/** What each block does, in the visitor's terms — shown under its name in the palette. */
export const BLOCK_DESCRIPTIONS: Record<BlockType, string> = {
  text: 'A heading and paragraphs.',
  image: 'A picture from a record, with optional text and a button over it.',
  hero: 'A large title, a subtitle and a button.',
  record_list: 'Records as a grid of cards or a table.',
  record_detail: 'One record: its picture and fields.',
  record_carousel: 'A row of record cards that scrolls sideways.',
  image_carousel: 'Pictures one at a time, with arrows and swipe.',
  event_booking: 'An event’s sessions, booked by visitors.',
  appointment_booking: 'Free time slots of an appointment event.',
  event_list: 'Upcoming events, soonest first.',
  section: 'A colored or picture band other blocks sit on.',
  form: 'Fields visitors fill in, saved into records.',
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

/** The palette's groups, by what a block is for. Every block type is in exactly one. */
export const BLOCK_GROUPS: { label: string; types: BlockType[] }[] = [
  { label: 'Layout and content', types: ['hero', 'text', 'image', 'section', 'image_carousel'] },
  { label: 'Records', types: ['record_list', 'record_carousel', 'record_detail'] },
  { label: 'Events', types: ['event_list', 'event_booking', 'appointment_booking'] },
  { label: 'Visitors', types: ['form'] },
]

/** A short text telling apart two blocks of the same type: its own title, heading or button, else its table. */
export function blockCaption(block: Block): string {
  const c = block.config
  const text = [c.title, c.heading, c.cta_label, c.submit_label].find((v) => typeof v === 'string' && v.trim())
  if (typeof text === 'string') return text.trim().slice(0, 48)
  return typeof c.table === 'string' ? c.table : ''
}

export function BlockIcon({ type }: { type: BlockType }) {
  return <FontAwesomeIcon icon={byPrefixAndName.fas[BLOCK_ICONS[type]]} fixedWidth />
}

export function BlockPalette({ onAdd, variant = 'outlined' }: { onAdd: (type: BlockType) => void; variant?: 'outlined' | 'contained' }) {
  const t = useT()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  return (
    <>
      <Button variant={variant} startIcon={<FontAwesomeIcon icon={byPrefixAndName.fas.plus} />}
        aria-haspopup="menu" aria-expanded={anchor != null} onClick={(e) => setAnchor(e.currentTarget)}>
        {t('Add block')}
      </Button>
      <Menu anchorEl={anchor} open={anchor != null} onClose={() => setAnchor(null)}
        slotProps={{ paper: { sx: { width: 340, maxHeight: '70vh' } }, list: { dense: true, sx: { py: 0.5 } } }}>
        {BLOCK_GROUPS.map((g) => (
          <Fragment key={g.label}>
            <ListSubheader sx={{ lineHeight: '32px', fontWeight: 600, color: 'text.secondary' }}>{t(g.label)}</ListSubheader>
            {g.types.map((type) => (
              <MenuItem key={type} onClick={() => { setAnchor(null); onAdd(type) }} sx={{ alignItems: 'flex-start', py: 0.75 }}>
                <ListItemIcon sx={{ mt: 0.5, color: 'text.secondary' }}><BlockIcon type={type} /></ListItemIcon>
                <ListItemText primary={t(BLOCK_LABELS[type])} secondary={t(BLOCK_DESCRIPTIONS[type])}
                  slotProps={{ primary: { sx: { fontWeight: 600 } }, secondary: { sx: { whiteSpace: 'normal' } } }} />
              </MenuItem>
            ))}
          </Fragment>
        ))}
      </Menu>
    </>
  )
}

/** Keeps BLOCK_GROUPS honest: the types no group lists (tests assert it is empty). */
export const ungroupedBlockTypes = () => BLOCK_TYPES.filter((type) => !BLOCK_GROUPS.some((g) => g.types.includes(type)))
