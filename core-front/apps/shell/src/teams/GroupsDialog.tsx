'use client'
import { useCallback, useEffect, useState } from 'react'
import Alert from '@mui/material/Alert'
import Autocomplete from '@mui/material/Autocomplete'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import { T, useT } from '@eerp/core-front'
import { createGroup, deleteGroup, listGroups, updateGroup, type Group, type Member } from './client'

/** One group row (or the "New group" form when `group` is absent). */
function GroupEditor({ group, members, onSave, onDelete }: {
  group?: Group
  members: Member[]
  onSave: (name: string, userIds: string[]) => Promise<unknown>
  onDelete?: () => void
}) {
  const t = useT()
  const [name, setName] = useState(group?.name ?? '')
  const [ids, setIds] = useState(group?.user_ids ?? [])
  return (
    <Stack role="group" aria-label={group?.name ?? t('New group')} direction="row" spacing={1} sx={{ alignItems: 'flex-start', py: 1 }}>
      <TextField size="small" label={t('Group name')} value={name} onChange={(e) => setName(e.target.value)} />
      <Autocomplete
        multiple
        sx={{ flex: 1, minWidth: 0 }}
        options={members}
        value={members.filter((m) => ids.includes(m.user_id))}
        onChange={(_, v) => setIds(v.map((m) => m.user_id))}
        getOptionLabel={(m) => m.display_name || t('Disabled user')}
        isOptionEqualToValue={(a, b) => a.user_id === b.user_id}
        renderInput={(p) => <TextField {...p} label={t('Members')} size="small" />}
      />
      <Button variant="contained" disabled={!name.trim()} onClick={() => {
        void onSave(name.trim(), ids).then(() => { if (!group) { setName(''); setIds([]) } }, () => {})
      }}>{group ? <T text="Save" /> : <T text="Create" />}</Button>
      {onDelete && <Button color="error" onClick={onDelete}><T text="Delete" /></Button>}
    </Stack>
  )
}

/** Team groups (owners): reusable sets of members, used in conversation access lists. */
export function GroupsDialog({ open, teamId, members, onClose }: { open: boolean; teamId: string; members: Member[]; onClose: () => void }) {
  const t = useT()
  const [groups, setGroups] = useState<Group[]>([])
  const [error, setError] = useState('')
  const [deleting, setDeleting] = useState<Group | null>(null)
  const fail = (e: unknown) => { setError(e instanceof Error && e.message ? e.message : t('The change could not be saved.')); throw e }
  const reload = useCallback(() => {
    listGroups(teamId).then(setGroups).catch(() => setGroups([]))
  }, [teamId])
  useEffect(() => { if (open) { setError(''); reload() } }, [open, reload])

  const run = (p: Promise<unknown>) => { setError(''); return p.then(reload, fail) }

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle><T text="Groups" /></DialogTitle>
      <DialogContent>
        {error && <Alert severity="error" sx={{ mb: 1 }}>{error}</Alert>}
        <Box>
          {groups.map((g) => (
            <GroupEditor key={`${g.id}:${g.name}:${g.user_ids.join()}`} group={g} members={members}
              onSave={(name, ids) => run(updateGroup(teamId, g.id, { name, user_ids: ids }))}
              onDelete={() => setDeleting(g)} />
          ))}
          <GroupEditor members={members} onSave={(name, ids) => run(createGroup(teamId, { name, user_ids: ids }))} />
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}><T text="Close" /></Button>
      </DialogActions>
      <Dialog open={!!deleting} onClose={() => setDeleting(null)} maxWidth="xs" fullWidth>
        <DialogTitle><T text="Delete group" /></DialogTitle>
        <DialogContent>
          <T text="Are you sure?" /> {deleting?.name}
          <Box sx={{ mt: 1 }}><T text="Conversations that only this group could see will be visible to owners only." /></Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleting(null)}><T text="Cancel" /></Button>
          <Button variant="contained" color="error" onClick={() => {
            const g = deleting
            setDeleting(null)
            if (g) void run(deleteGroup(teamId, g.id)).catch(() => {})
          }}><T text="Confirm" /></Button>
        </DialogActions>
      </Dialog>
    </Dialog>
  )
}
