'use client'
import { useEffect, useState } from 'react'
import Autocomplete from '@mui/material/Autocomplete'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { T, useT } from '@eerp/core-front'
import { directory, getShares, setShares, type DirectoryUser } from './client'

/** Pick the staff a file is shared with; saving replaces the whole share list. */
export function ShareDialog({ open, fileId, onClose, onSaved }: { open: boolean; fileId: string; onClose: () => void; onSaved: () => void }) {
  const t = useT()
  const [users, setUsers] = useState<DirectoryUser[]>([])
  const [picked, setPicked] = useState<DirectoryUser[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    directory().then(setUsers).catch(() => setUsers([]))
    getShares(fileId).then((s) => setPicked(s.map((x) => ({ id: x.user_id, display_name: x.display_name, email: x.email })))).catch(() => setPicked([]))
  }, [open, fileId])

  const save = () => {
    setError('')
    setShares(fileId, picked.map((u) => u.id)).then(() => { onSaved(); onClose() })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : t('The change could not be saved.')))
  }

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle><T text="Share file" /></DialogTitle>
      <DialogContent>
        <Autocomplete
          multiple
          sx={{ mt: 1 }}
          options={users}
          value={picked}
          onChange={(_, v) => setPicked(v)}
          getOptionLabel={(u) => u.display_name}
          isOptionEqualToValue={(a, b) => a.id === b.id}
          renderInput={(params) => <TextField {...params} label={t('Share with')} size="small" />}
        />
        {error && <Typography color="error" variant="body2" sx={{ mt: 1 }}>{error}</Typography>}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}><T text="Cancel" /></Button>
        <Button variant="contained" onClick={save}><T text="Save" /></Button>
      </DialogActions>
    </Dialog>
  )
}
