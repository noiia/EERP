'use client'
import { useEffect, useState } from 'react'
import Autocomplete from '@mui/material/Autocomplete'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import List from '@mui/material/List'
import ListItem from '@mui/material/ListItem'
import ListItemText from '@mui/material/ListItemText'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { T, useT } from '@eerp/core-front'
import { addMember, directory, removeMember, setMemberRole, type DirectoryUser, type Member, type Role } from './client'

const ROLES: Role[] = ['owner', 'member', 'guest']

/** A staff directory search; `exclude` hides ids already picked elsewhere. */
export function DirectoryPicker({ label, exclude = [], value, onChange }: {
  label: string
  exclude?: string[]
  value: DirectoryUser | null
  onChange: (u: DirectoryUser | null) => void
}) {
  const [users, setUsers] = useState<DirectoryUser[]>([])
  useEffect(() => {
    directory().then(setUsers).catch(() => setUsers([]))
  }, [])
  return (
    <Autocomplete
      options={users.filter((u) => !exclude.includes(u.id))}
      value={value}
      onChange={(_, u) => onChange(u)}
      getOptionLabel={(u) => `${u.display_name} (${u.email})`}
      isOptionEqualToValue={(a, b) => a.id === b.id}
      renderInput={(params) => <TextField {...params} label={label} size="small" />}
      fullWidth
    />
  )
}

function RoleSelect({ value, onChange }: { value: Role; onChange: (r: Role) => void }) {
  const t = useT()
  return (
    <TextField select size="small" value={value} onChange={(e) => onChange(e.target.value as Role)}
      slotProps={{ select: { native: true }, htmlInput: { 'aria-label': t('Role') } }}>
      {ROLES.map((r) => <option key={r} value={r}>{t(r[0].toUpperCase() + r.slice(1))}</option>)}
    </TextField>
  )
}

export function MembersDialog({ open, teamId, members, onClose, onChanged }: {
  open: boolean
  teamId: string
  members: Member[]
  onClose: () => void
  onChanged: () => void
}) {
  const t = useT()
  const [picked, setPicked] = useState<DirectoryUser | null>(null)
  const [role, setRole] = useState<Role>('member')
  const [error, setError] = useState('')

  const run = (p: Promise<unknown>) => {
    setError('')
    p.then(onChanged).catch((e: unknown) => setError(e instanceof Error ? e.message : t('The change could not be saved.')))
  }

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle><T text="Manage members" /></DialogTitle>
      <DialogContent>
        <Stack direction="row" spacing={1} sx={{ mt: 1, alignItems: 'center' }}>
          <DirectoryPicker label={t('Add a person')} exclude={members.map((m) => m.user_id)} value={picked} onChange={setPicked} />
          <RoleSelect value={role} onChange={setRole} />
          <Button variant="contained" disabled={!picked} onClick={() => {
            if (!picked) return
            run(addMember(teamId, picked.id, role))
            setPicked(null)
          }}><T text="Add" /></Button>
        </Stack>
        {error && <Typography color="error" variant="body2" sx={{ mt: 1 }}>{error}</Typography>}
        <List>
          {members.map((m) => (
            <ListItem key={m.user_id} aria-label={m.display_name} disableGutters
              secondaryAction={
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                  <RoleSelect value={m.role} onChange={(r) => run(setMemberRole(teamId, m.user_id, r))} />
                  <Button color="error" onClick={() => run(removeMember(teamId, m.user_id))}><T text="Remove" /></Button>
                </Stack>
              }>
              <ListItemText primary={m.display_name} secondary={m.email} />
            </ListItem>
          ))}
        </List>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}><T text="Close" /></Button>
      </DialogActions>
    </Dialog>
  )
}
