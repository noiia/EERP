'use client'
import { useEffect, useState } from 'react'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import List from '@mui/material/List'
import ListItemButton from '@mui/material/ListItemButton'
import ListItemText from '@mui/material/ListItemText'
import Typography from '@mui/material/Typography'
import { T } from '@eerp/core-front'
import { listFiles, type FolderListing } from './client'

/** Browse the team's folders and pick a destination; onPick('') means the root. */
export function FolderPicker({ open, teamId, onPick, onClose }: { open: boolean; teamId: string; onPick: (folderId: string) => void; onClose: () => void }) {
  const [current, setCurrent] = useState<string | undefined>()
  const [listing, setListing] = useState<FolderListing | null>(null)

  useEffect(() => {
    if (open) setCurrent(undefined)
  }, [open])
  useEffect(() => {
    if (open) listFiles(teamId, current).then(setListing).catch(() => setListing(null))
  }, [open, teamId, current])

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle><T text="Move to" /></DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary">/ {listing?.path.map((p) => p.name).join(' / ')}</Typography>
        <List dense>
          {current && <ListItemButton onClick={() => setCurrent(listing?.folder?.parent_id ?? undefined)}><ListItemText primary=".." /></ListItemButton>}
          {listing?.folders.map((f) => (
            <ListItemButton key={f.id} onClick={() => setCurrent(f.id)}><ListItemText primary={f.name} /></ListItemButton>
          ))}
        </List>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}><T text="Cancel" /></Button>
        <Button variant="contained" onClick={() => onPick(current ?? '')}><T text="Move here" /></Button>
      </DialogActions>
    </Dialog>
  )
}
