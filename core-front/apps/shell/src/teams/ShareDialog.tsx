'use client'
import { useEffect, useState } from 'react'
import Alert from '@mui/material/Alert'
import Autocomplete from '@mui/material/Autocomplete'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Divider from '@mui/material/Divider'
import FormControlLabel from '@mui/material/FormControlLabel'
import Radio from '@mui/material/Radio'
import RadioGroup from '@mui/material/RadioGroup'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { T, useT } from '@eerp/core-front'
import {
  createLink,
  directory,
  getLinks,
  getShares,
  revokeLink,
  setShares,
  type DirectoryUser,
  type FileLink,
} from './client'

const DAY = 24 * 3600 * 1000
const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const daysFromNow = (n: number) => ymd(new Date(Date.now() + n * DAY))

/** The picked local day's end, capped a minute under Go's 90-day limit. */
export function linkExpiry(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  const end = new Date(y!, m! - 1, d!, 23, 59).getTime()
  return new Date(Math.min(end, Date.now() + 90 * DAY - 60_000)).toISOString()
}

/** Pick the staff a file is shared with (saving replaces the whole list), and manage its download links. */
export function ShareDialog({ open, fileId, onClose, onSaved }: { open: boolean; fileId: string; onClose: () => void; onSaved: () => void }) {
  const t = useT()
  const [users, setUsers] = useState<DirectoryUser[]>([])
  const [picked, setPicked] = useState<DirectoryUser[]>([])
  const [error, setError] = useState('')
  const [links, setLinks] = useState<FileLink[]>([])
  const [expires, setExpires] = useState(() => daysFromNow(7))
  const [created, setCreated] = useState('')
  const [linkError, setLinkError] = useState('')
  const [isPublic, setIsPublic] = useState(false)

  useEffect(() => {
    if (!open) return
    directory().then(setUsers).catch(() => setUsers([]))
    getShares(fileId).then((s) => setPicked(s.map((x) => ({ id: x.user_id, display_name: x.display_name, email: x.email })))).catch(() => setPicked([]))
    getLinks(fileId).then(setLinks).catch(() => setLinks([]))
    setCreated('')
    setLinkError('')
    setIsPublic(false)
  }, [open, fileId])

  const save = () => {
    setError('')
    setShares(fileId, picked.map((u) => u.id)).then(() => { onSaved(); onClose() })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : t('The change could not be saved.')))
  }

  const create = () => {
    setLinkError('')
    createLink(fileId, linkExpiry(expires), isPublic)
      .then((l) => {
        const url = `${window.location.origin}${l.url ?? ''}`
        setCreated(url)
        setLinks((ls) => [l, ...ls])
        navigator.clipboard?.writeText(url).catch(() => {})
      })
      .catch((e: unknown) => setLinkError(e instanceof Error ? e.message : t('The change could not be saved.')))
  }

  const revoke = (id: string) => {
    setLinkError('')
    revokeLink(id)
      .then(() => setLinks((ls) => ls.filter((l) => l.id !== id)))
      .catch((e: unknown) => setLinkError(e instanceof Error ? e.message : t('The change could not be saved.')))
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

        <Divider sx={{ my: 2 }} />
        <Typography variant="subtitle2"><T text="Download links" /></Typography>
        {!isPublic && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            <T text="Anyone signed in to this workspace with the link can download this file until it expires." />
          </Typography>
        )}
        <RadioGroup row value={isPublic ? 'public' : 'members'} onChange={(e) => setIsPublic(e.target.value === 'public')}>
          <FormControlLabel value="members" control={<Radio size="small" />} label={t('Workspace members only')} />
          <FormControlLabel value="public" control={<Radio size="small" />} label={t('Anyone with the link')} />
        </RadioGroup>
        {isPublic && (
          <Alert severity="warning" sx={{ my: 1 }}>
            <T text="Anyone who gets this link can download the file without signing in." />
          </Alert>
        )}
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <TextField
            type="date"
            size="small"
            label={t('Expires on')}
            value={expires}
            onChange={(e) => setExpires(e.target.value)}
            slotProps={{ inputLabel: { shrink: true }, htmlInput: { min: daysFromNow(1), max: daysFromNow(90) } }}
          />
          <Button variant="outlined" onClick={create} disabled={!expires}><T text="Create link" /></Button>
        </Stack>
        {created && (
          <TextField
            fullWidth
            size="small"
            sx={{ mt: 1 }}
            label={t('Link copied')}
            value={created}
            slotProps={{ htmlInput: { readOnly: true }, inputLabel: { shrink: true } }}
            onFocus={(e) => e.target.select()}
          />
        )}
        {linkError && <Typography color="error" variant="body2" sx={{ mt: 1 }}>{linkError}</Typography>}
        {links.map((l) => (
          <Stack key={l.id} direction="row" spacing={1} sx={{ alignItems: 'center', mt: 1 }}>
            {l.public && <Chip size="small" color="warning" label={t('Public')} />}
            <Typography variant="body2" sx={{ flex: 1 }}>
              {t('Expires on')} {new Date(l.expires_at).toLocaleDateString()} · {l.created_by_name} · {l.download_count} {t('downloads')}
            </Typography>
            <Button size="small" color="error" onClick={() => revoke(l.id)}><T text="Revoke" /></Button>
          </Stack>
        ))}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}><T text="Cancel" /></Button>
        <Button variant="contained" onClick={save}><T text="Save" /></Button>
      </DialogActions>
    </Dialog>
  )
}
