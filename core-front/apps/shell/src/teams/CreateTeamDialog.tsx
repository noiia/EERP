'use client'
import { useState } from 'react'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import TextField from '@mui/material/TextField'
import { T, useT } from '@eerp/core-front'
import { createTeam, type Team } from './client'

export function CreateTeamDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (t: Team) => void }) {
  const t = useT()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit() {
    setBusy(true)
    setError('')
    try {
      onCreated(await createTeam(name.trim(), description.trim()))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle><T text="Create team" /></DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '8px !important' }}>
        {error && <Alert severity="error">{error}</Alert>}
        <TextField label={t('Name')} value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
        <TextField label={t('Description')} value={description} onChange={(e) => setDescription(e.target.value)} multiline minRows={2} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}><T text="Cancel" /></Button>
        <Button variant="contained" onClick={submit} disabled={!name.trim() || busy}><T text="Create" /></Button>
      </DialogActions>
    </Dialog>
  )
}
