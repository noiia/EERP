'use client'
import { useEffect, useState } from 'react'
import Alert from '@mui/material/Alert'
import Autocomplete from '@mui/material/Autocomplete'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { T, useT } from '@eerp/core-front'
import { getAccess, listGroups, setAccess, type Channel, type Group, type Member } from './client'

/** Who may see one conversation (owners always can): team members and groups. */
export function AccessDialog({ open, teamId, channel, members, onClose, onSaved }: {
  open: boolean
  teamId: string
  channel: Channel
  members: Member[]
  onClose: () => void
  onSaved: () => void
}) {
  const t = useT()
  const [groups, setGroups] = useState<Group[]>([])
  const [users, setUsers] = useState<string[]>([])
  const [groupIds, setGroupIds] = useState<string[]>([])
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    if (!open) return
    setLoaded(false)
    setConfirming(false)
    setError('')
    Promise.all([getAccess(teamId, channel.id), listGroups(teamId)])
      .then(([a, g]) => { setUsers(a.user_ids); setGroupIds(a.group_ids); setGroups(g); setLoaded(true) })
      .catch((e: unknown) => setError(e instanceof Error && e.message ? e.message : t('The change could not be saved.')))
    // `t` is left out of the deps: it changes identity per render
  }, [open, teamId, channel.id])

  const empty = users.length === 0 && groupIds.length === 0
  // An empty list reopens the conversation to the whole team: never on a private one without a second, explicit click.
  const needsConfirm = !!channel.private && empty
  const save = () => {
    if (needsConfirm && !confirming) { setConfirming(true); return }
    setError('')
    setAccess(teamId, channel.id, { user_ids: users, group_ids: groupIds })
      .then(onSaved)
      .catch((e: unknown) => setError(e instanceof Error && e.message ? e.message : t('The change could not be saved.')))
  }

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle><T text="Manage access" /> # {channel.name}</DialogTitle>
      <DialogContent>
        {error && <Alert severity="error" sx={{ mb: 1 }}>{error}</Alert>}
        {confirming && <Alert severity="warning" sx={{ mb: 1 }}><T text="Saving an empty list opens this conversation to the whole team." /></Alert>}
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Autocomplete
            multiple
            disabled={!loaded}
            options={members}
            value={members.filter((m) => users.includes(m.user_id))}
            onChange={(_, v) => { setConfirming(false); setUsers(v.map((m) => m.user_id)) }}
            getOptionLabel={(m) => m.display_name || t('Disabled user')}
            isOptionEqualToValue={(a, b) => a.user_id === b.user_id}
            renderInput={(p) => <TextField {...p} label={t('People')} size="small" />}
          />
          <Autocomplete
            multiple
            disabled={!loaded}
            options={groups}
            value={groups.filter((g) => groupIds.includes(g.id))}
            onChange={(_, v) => { setConfirming(false); setGroupIds(v.map((g) => g.id)) }}
            getOptionLabel={(g) => g.name}
            isOptionEqualToValue={(a, b) => a.id === b.id}
            renderInput={(p) => <TextField {...p} label={t('Groups')} size="small" />}
          />
          {loaded && empty && (
            <Typography variant="body2" color="text.secondary">
              {channel.private ? <T text="Only owners can see this conversation." /> : <T text="Open to the whole team" />}
            </Typography>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}><T text="Cancel" /></Button>
        <Button variant="contained" color={confirming ? 'warning' : 'primary'} disabled={!loaded} onClick={save}>{confirming ? <T text="Open to the whole team" /> : <T text="Save" />}</Button>
      </DialogActions>
    </Dialog>
  )
}
