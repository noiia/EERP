'use client'
import { useState } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import ButtonBase from '@mui/material/ButtonBase'
import Chip from '@mui/material/Chip'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { T } from '@eerp/core-front'
import type { Attachment } from './client'

// Raster types only: an SVG can carry script, so it is never inlined.
const INLINE = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

export const attachmentUrl = (a: Attachment) => (a.kind === 'file' ? `/api/teams/files/${a.id}/download` : `/api/teams/attachments/${a.id}`)

/** A message's attachments: raster images as a thumbnail grid with a viewer, anything else as chips. */
export function ImageAttachments({ attachments }: { attachments: Attachment[] }) {
  const [viewing, setViewing] = useState<Attachment | null>(null)
  if (attachments.length === 0) return null
  const images = attachments.filter((a) => !a.deleted && INLINE.has(a.mime))
  const others = attachments.filter((a) => !images.includes(a))
  return (
    <>
      {images.length > 0 && (
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', mt: 0.5 }}>
          {images.map((a) => (
            <ButtonBase key={a.id} aria-label={a.filename} onClick={() => setViewing(a)} sx={{ borderRadius: 1, overflow: 'hidden' }}>
              <Box component="img" src={attachmentUrl(a)} alt={a.filename} loading="lazy" sx={{ display: 'block', maxWidth: 320, maxHeight: 240, objectFit: 'contain' }} />
            </ButtonBase>
          ))}
        </Stack>
      )}
      {others.length > 0 && (
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', mt: 0.5 }}>
          {others.map((a) => a.deleted
            ? <Typography key={a.id} variant="body2" color="text.secondary" sx={{ fontStyle: 'italic' }}><T text="File deleted" /></Typography>
            : <Chip key={a.id} component="a" href={attachmentUrl(a)} clickable size="small" label={a.filename} />)}
        </Stack>
      )}
      <Dialog open={viewing !== null} onClose={() => setViewing(null)} maxWidth="lg">
        <DialogTitle sx={{ overflowWrap: 'anywhere' }}>{viewing?.filename}</DialogTitle>
        <DialogContent>
          {viewing && <Box component="img" src={attachmentUrl(viewing)} alt={viewing.filename} sx={{ display: 'block', maxWidth: '100%', maxHeight: '75vh', objectFit: 'contain' }} />}
        </DialogContent>
        <DialogActions>
          <Button component="a" href={viewing ? attachmentUrl(viewing) : undefined}><T text="Download" /></Button>
          <Button onClick={() => setViewing(null)}><T text="Close" /></Button>
        </DialogActions>
      </Dialog>
    </>
  )
}
