'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Breadcrumbs from '@mui/material/Breadcrumbs'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Link from '@mui/material/Link'
import Stack from '@mui/material/Stack'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { erpPath, IntentLink, T, useSessionStore, useT } from '@eerp/core-front'
import {
  createFolder, deleteFile, deleteFolder, listFiles, updateFile, updateFolder, uploadFile,
  type FolderListing, type Role,
} from './client'
import { FolderPicker } from './FolderPicker'
import { ShareDialog } from './ShareDialog'

export const formatSize = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`)

type Dlg =
  | { kind: 'newFolder' }
  | { kind: 'rename'; target: 'file' | 'folder'; id: string; name: string }
  | { kind: 'delete'; target: 'file' | 'folder'; id: string; name: string }
  | { kind: 'move'; target: 'file' | 'folder'; id: string }
  | { kind: 'share'; id: string }

/** The team's file manager: a folder listing with upload, rename, move, share and delete.
 * With rootFolderId it browses below that folder only, in place (no URL change): a conversation's folder panel. */
export function FilesPane({ teamId, folderId: urlFolder, rootFolderId, compact = false, role, onFoldersChanged, onFolderName }: {
  teamId: string; folderId?: string; rootFolderId?: string; compact?: boolean; role?: Role
  onFoldersChanged?: () => void; onFolderName?: (name: string | null) => void
}) {
  const t = useT()
  const [inPanel, setInPanel] = useState<string | undefined>()
  const folderId = rootFolderId ? inPanel ?? rootFolderId : urlFolder
  const me = useSessionStore((s) => s.identity?.userId)
  const [listing, setListing] = useState<FolderListing | null>(null)
  const [missing, setMissing] = useState(false)
  const [gone, setGone] = useState(false)
  const [error, setError] = useState('')
  const [dlg, setDlg] = useState<Dlg | null>(null)
  const [name, setName] = useState('')
  const input = useRef<HTMLInputElement>(null)

  const reload = useCallback(() => {
    listFiles(teamId, folderId).then((l) => { setListing(l); setMissing(false); setGone(false) }).catch((e: unknown) => {
      const { status, code } = e as { status?: number; code?: string }
      // Go mounts the files routes only when S3 is configured: an unmounted route's 404 has no Go error code.
      if (status === 404 && !code) setMissing(true)
      else if (status === 404) setGone(true)
      else setError(e instanceof Error ? e.message : t('The change could not be saved.'))
    })
  }, [teamId, folderId, t])
  useEffect(reload, [reload])
  const folderName = folderId ? listing?.folder?.name ?? null : null
  useEffect(() => onFolderName?.(folderName), [folderName, onFolderName])

  const run = (p: Promise<unknown>, folders = false) => {
    setError('')
    p.then(() => { setDlg(null); reload(); if (folders) onFoldersChanged?.() }).catch((e: unknown) => setError(e instanceof Error ? e.message : t('The change could not be saved.')))
  }
  const canEdit = (owner: string) => role === 'owner' || (role === 'member' && owner === me)
  const canWrite = role === 'owner' || role === 'member'

  if (missing) return <Typography color="text.secondary" sx={{ p: 3 }} data-testid="teams-files-pane"><T text="File storage is not configured." /></Typography>
  if (gone) {
    return (
      <Box sx={{ p: 3 }} data-testid="teams-files-pane">
        <Typography color="text.secondary"><T text="This folder no longer exists." /></Typography>
        {rootFolderId
          ? inPanel && <Link component="button" onClick={() => setInPanel(undefined)} underline="hover"><T text="Back" /></Link>
          : <Link component={IntentLink} href={erpPath(`/teams/${teamId}/files`)} underline="hover"><T text="All files" /></Link>}
      </Box>
    )
  }

  const submitName = () => {
    if (!dlg || !name.trim()) return
    if (dlg.kind === 'newFolder') run(createFolder(teamId, name.trim(), folderId), true)
    else if (dlg.kind === 'rename') run(dlg.target === 'file' ? updateFile(teamId, dlg.id, { name: name.trim() }) : updateFolder(teamId, dlg.id, { name: name.trim() }), dlg.target === 'folder')
  }
  const openName = (d: Dlg, initial = '') => { setName(initial); setDlg(d) }

  const folderLink = (id: string, label: string) => rootFolderId
    ? <Link key={id} component="button" onClick={() => setInPanel(id)} underline="hover" sx={{ verticalAlign: 'baseline' }}>{label}</Link>
    : <Link key={id} component={IntentLink} href={erpPath(`/teams/${teamId}/files?folder=${id}`)} underline="hover">{label}</Link>
  // Rooted: the crumbs above the root are hidden, even when the viewer could see them.
  const crumbs = rootFolderId ? listing?.path.slice(Math.max(0, listing.path.findIndex((p) => p.id === rootFolderId))) : listing?.path

  const actions = (kind: 'file' | 'folder', id: string, label: string, owner: string) => canEdit(owner) && (
    <Stack direction="row" spacing={0.5} sx={{ justifyContent: 'flex-end' }}>
      {kind === 'file' && <Button size="small" onClick={() => setDlg({ kind: 'share', id })}><T text="Share" /></Button>}
      <Button size="small" onClick={() => setDlg({ kind: 'move', target: kind, id })}><T text="Move" /></Button>
      <Button size="small" onClick={() => openName({ kind: 'rename', target: kind, id, name: label }, label)}><T text="Rename" /></Button>
      <Button size="small" color="error" onClick={() => setDlg({ kind: 'delete', target: kind, id, name: label })}><T text="Delete" /></Button>
    </Stack>
  )

  return (
    <Box data-testid="teams-files-pane" sx={{ p: compact ? 1 : 2, overflow: 'auto', height: '100%' }}>
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1, flexWrap: 'wrap', gap: 1 }}>
        <Breadcrumbs aria-label={t('Path')}>
          {!rootFolderId && <Link component={IntentLink} href={erpPath(`/teams/${teamId}/files`)} underline="hover"><T text="All files" /></Link>}
          {crumbs?.map((p) => folderLink(p.id, p.name))}
        </Breadcrumbs>
        {canWrite && (
          <Stack direction="row" spacing={1}>
            <Button onClick={() => openName({ kind: 'newFolder' })}><T text="New folder" /></Button>
            <Button variant="contained" onClick={() => input.current?.click()}><T text="Upload" /></Button>
            <input ref={input} type="file" multiple hidden data-testid="teams-upload-input" onChange={(e) => {
              const files = Array.from(e.target.files ?? [])
              e.target.value = ''
              if (files.length) run(Promise.all(files.map((f) => uploadFile(teamId, f, folderId))))
            }} />
          </Stack>
        )}
      </Stack>
      {error && <Alert severity="error" sx={{ mb: 1 }}>{error}</Alert>}
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell><T text="Name" /></TableCell>
            {!compact && <TableCell><T text="Size" /></TableCell>}
            {!compact && <TableCell><T text="Uploaded by" /></TableCell>}
            <TableCell />
          </TableRow>
        </TableHead>
        <TableBody>
          {listing?.folders.map((f) => (
            <TableRow key={f.id}>
              <TableCell colSpan={compact ? 1 : 3}>{folderLink(f.id, f.name)}</TableCell>
              <TableCell>{actions('folder', f.id, f.name, f.created_by)}</TableCell>
            </TableRow>
          ))}
          {listing?.files.map((f) => (
            <TableRow key={f.id}>
              <TableCell><Link href={`/api/teams/files/${f.id}/download`}>{f.name}</Link></TableCell>
              {!compact && <TableCell>{formatSize(f.size)}</TableCell>}
              {!compact && <TableCell>{f.uploaded_by_name}</TableCell>}
              <TableCell>{actions('file', f.id, f.name, f.uploaded_by)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <Dialog open={dlg?.kind === 'newFolder' || dlg?.kind === 'rename'} onClose={() => setDlg(null)} fullWidth maxWidth="xs">
        <DialogTitle>{dlg?.kind === 'rename' ? <T text="Rename" /> : <T text="New folder" />}</DialogTitle>
        <DialogContent>
          <TextField autoFocus fullWidth size="small" sx={{ mt: 1 }} label={t('Name')} value={name} onChange={(e) => setName(e.target.value)} />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDlg(null)}><T text="Cancel" /></Button>
          <Button variant="contained" disabled={!name.trim()} onClick={submitName}><T text="Save" /></Button>
        </DialogActions>
      </Dialog>

      <Dialog open={dlg?.kind === 'delete'} onClose={() => setDlg(null)}>
        <DialogTitle><T text="Delete" /></DialogTitle>
        <DialogContent>
          <Typography><T text="This cannot be undone." /> {dlg?.kind === 'delete' ? dlg.name : ''}</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDlg(null)}><T text="Cancel" /></Button>
          <Button color="error" variant="contained" onClick={() => {
            if (dlg?.kind === 'delete') run(dlg.target === 'file' ? deleteFile(teamId, dlg.id) : deleteFolder(teamId, dlg.id), dlg.target === 'folder')
          }}><T text="Delete" /></Button>
        </DialogActions>
      </Dialog>

      <FolderPicker open={dlg?.kind === 'move'} teamId={teamId} moveError={dlg?.kind === 'move' ? error : undefined} exclude={dlg?.kind === 'move' && dlg.target === 'folder' ? dlg.id : undefined} onClose={() => setDlg(null)}
        onPick={(folder) => {
          if (dlg?.kind !== 'move') return
          run(dlg.target === 'file' ? updateFile(teamId, dlg.id, { folder_id: folder }) : updateFolder(teamId, dlg.id, { parent_id: folder }), dlg.target === 'folder')
        }} />
      <ShareDialog open={dlg?.kind === 'share'} fileId={dlg?.kind === 'share' ? dlg.id : ''} onClose={() => setDlg(null)} onSaved={reload} />
    </Box>
  )
}
