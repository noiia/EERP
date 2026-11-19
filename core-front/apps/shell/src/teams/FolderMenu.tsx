'use client'
import { useState } from 'react'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import IconButton from '@mui/material/IconButton'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { T, useSessionStore, useT } from '@eerp/core-front'
import { createFolder, deleteFolder, folderDownloadUrl, updateFolder, type Channel, type Folder, type Member, type Role } from './client'
import { AccessDialog } from './AccessDialog'
import { FolderPicker } from './FolderPicker'

type Dlg = 'newFolder' | 'rename' | 'move' | 'delete' | 'access'

/** The ⋮ menu of a sidebar folder: new subfolder, download (zip), rename, move, manage access
 * (owners, on the folder a conversation is linked to: its privacy follows that conversation), delete.
 * Each entry follows the caller's team role; Go enforces the same rules. */
export function FolderMenu({ teamId, folder, role, channels, members, onChanged, onAccessSaved }: {
  teamId: string; folder: Folder; role?: Role; channels: Channel[]; members: Member[]
  /** A folder was created, renamed, moved or deleted. */
  onChanged: () => void
  onAccessSaved: () => void
}) {
  const t = useT()
  const me = useSessionStore((s) => s.identity?.userId)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [dlg, setDlg] = useState<Dlg | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const canWrite = role === 'owner' || role === 'member'
  const canEdit = role === 'owner' || (role === 'member' && folder.created_by === me)
  const linked = role === 'owner' ? channels.find((c) => c.folder_id === folder.id) : undefined

  const open = (d: Dlg, initial = '') => { setAnchor(null); setError(''); setName(initial); setDlg(d) }
  // One request at a time: a double click must not send it twice.
  const run = (p: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true)
    setError('')
    p().then(() => { setDlg(null); onChanged() })
      .catch((e: unknown) => setError(e instanceof Error && e.message ? e.message : t('The change could not be saved.')))
      .finally(() => setBusy(false))
  }
  const submitName = () => {
    if (!name.trim()) return
    run(() => dlg === 'newFolder' ? createFolder(teamId, name.trim(), folder.id) : updateFolder(teamId, folder.id, { name: name.trim() }))
  }

  return (
    <>
      <IconButton size="small" aria-label={`${t('Folder options')} ${folder.name}`} onClick={(e) => setAnchor(e.currentTarget)}>⋮</IconButton>
      <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)}>
        {canWrite && <MenuItem onClick={() => open('newFolder')}><T text="New subfolder" /></MenuItem>}
        <MenuItem component="a" href={folderDownloadUrl(teamId, folder.id)} download onClick={() => setAnchor(null)}><T text="Download" /></MenuItem>
        {canEdit && <MenuItem onClick={() => open('rename', folder.name)}><T text="Rename" /></MenuItem>}
        {canEdit && <MenuItem onClick={() => open('move')}><T text="Move" /></MenuItem>}
        {linked && <MenuItem onClick={() => open('access')}><T text="Manage access" /></MenuItem>}
        {canEdit && <MenuItem onClick={() => open('delete')} sx={{ color: 'error.main' }}><T text="Delete" /></MenuItem>}
      </Menu>

      <Dialog open={dlg === 'newFolder' || dlg === 'rename'} onClose={() => setDlg(null)} fullWidth maxWidth="xs">
        <DialogTitle>{dlg === 'rename' ? <T text="Rename" /> : <T text="New subfolder" />}</DialogTitle>
        <DialogContent>
          {error && <Alert severity="error" sx={{ mb: 1 }}>{error}</Alert>}
          <TextField autoFocus fullWidth size="small" sx={{ mt: 1 }} label={t('Name')} value={name} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submitName() }} />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDlg(null)}><T text="Cancel" /></Button>
          <Button variant="contained" disabled={!name.trim() || busy} onClick={submitName}><T text="Save" /></Button>
        </DialogActions>
      </Dialog>

      <Dialog open={dlg === 'delete'} onClose={() => setDlg(null)}>
        <DialogTitle><T text="Delete" /></DialogTitle>
        <DialogContent>
          {error && <Alert severity="error" sx={{ mb: 1 }}>{error}</Alert>}
          <Typography><T text="This cannot be undone." /> {folder.name}</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDlg(null)}><T text="Cancel" /></Button>
          <Button color="error" variant="contained" disabled={busy} onClick={() => run(() => deleteFolder(teamId, folder.id))}><T text="Delete" /></Button>
        </DialogActions>
      </Dialog>

      <FolderPicker open={dlg === 'move'} teamId={teamId} exclude={folder.id} moveError={dlg === 'move' ? error : undefined} onClose={() => setDlg(null)}
        onPick={(parent) => run(() => updateFolder(teamId, folder.id, { parent_id: parent }))} />
      {linked && dlg === 'access' && (
        <AccessDialog open teamId={teamId} channel={linked} members={members} onClose={() => setDlg(null)} onSaved={() => { setDlg(null); onAccessSaved() }} />
      )}
    </>
  )
}
