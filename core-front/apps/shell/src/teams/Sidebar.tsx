'use client'
import { useEffect, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import Alert from '@mui/material/Alert'
import Badge from '@mui/material/Badge'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import IconButton from '@mui/material/IconButton'
import List from '@mui/material/List'
import ListItem from '@mui/material/ListItem'
import ListItemButton from '@mui/material/ListItemButton'
import ListItemText from '@mui/material/ListItemText'
import ListSubheader from '@mui/material/ListSubheader'
import TextField from '@mui/material/TextField'
import { erpPath, IntentLink, PresenceDot, T, usePresenceStore, useT } from '@eerp/core-front'
import { createChannel, listFiles, openDirect, type Channel, type DirectChat, type DirectoryUser, type Folder, type Member, type Role } from './client'
import { DirectoryPicker, MembersDialog } from './MembersDialog'

export type WorkspaceView = { kind: 'channel' | 'direct' | 'files' | 'shared'; id?: string }

function NavItem({ href, selected, unread = 0, children, indent = 0 }: { href: string; selected?: boolean; unread?: number; children: ReactNode; indent?: number }) {
  return (
    <ListItemButton component={IntentLink} href={erpPath(href)} selected={selected} dense sx={{ pl: 2 + indent * 2 }}>
      <ListItemText primary={children} />
      {unread > 0 && <Badge badgeContent={unread} color="primary" sx={{ mr: 1.5 }} />}
    </ListItemButton>
  )
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <List dense subheader={
      <ListSubheader sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', bgcolor: 'transparent', lineHeight: '36px' }}>
        {title}{action}
      </ListSubheader>
    }>
      {children}
    </List>
  )
}

function FolderNode({ teamId, folder, depth }: { teamId: string; folder: Folder; depth: number }) {
  const t = useT()
  const [children, setChildren] = useState<Folder[] | null>(null)
  const [open, setOpen] = useState(false)
  const toggle = () => {
    if (!open && children === null) listFiles(teamId, folder.id).then((l) => setChildren(l.folders)).catch(() => setChildren([]))
    setOpen(!open)
  }
  return (
    <>
      <Box sx={{ display: 'flex', alignItems: 'center' }}>
        <IconButton size="small" aria-label={open ? t('Collapse') : t('Expand')} aria-expanded={open} onClick={toggle} sx={{ ml: depth * 2 }}>
          {open ? '▾' : '▸'}
        </IconButton>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <NavItem href={`/teams/${teamId}/files?folder=${folder.id}`}>{folder.name}</NavItem>
        </Box>
      </Box>
      {open && children?.map((c) => <FolderNode key={c.id} teamId={teamId} folder={c} depth={depth + 1} />)}
    </>
  )
}

export function Sidebar({ teamId, role, members, channels, directs, unread, view, onChanged }: {
  teamId?: string
  role?: Role
  members: Member[]
  channels: Channel[]
  directs: DirectChat[]
  unread: Record<string, number>
  view: WorkspaceView
  onChanged: () => void
}) {
  const t = useT()
  const router = useRouter()
  const statuses = usePresenceStore((s) => s.statuses)
  // null = no file storage (Go doesn't mount the files routes without S3): the section is hidden.
  const [folders, setFolders] = useState<Folder[] | null>(null)
  const [newChannel, setNewChannel] = useState<string | null>(null)
  const [newDirect, setNewDirect] = useState(false)
  const [dmUser, setDmUser] = useState<DirectoryUser | null>(null)
  const [managing, setManaging] = useState(false)
  const [dialogError, setDialogError] = useState('')
  const fail = (e: unknown) => setDialogError(e instanceof Error && e.message ? e.message : t('The change could not be saved.'))
  const owner = role === 'owner'

  useEffect(() => {
    if (!teamId) return
    listFiles(teamId).then((l) => setFolders(l.folders)).catch(() => setFolders(null))
  }, [teamId])

  const addChannel = async () => {
    if (!teamId || !newChannel?.trim()) return
    const ch = await createChannel(teamId, newChannel.trim())
    setNewChannel(null)
    onChanged()
    router.push(erpPath(`/teams/${teamId}/channels/${ch.id}`))
  }
  const startDirect = async () => {
    if (!dmUser) return
    const d = await openDirect(dmUser.id)
    setNewDirect(false)
    setDmUser(null)
    onChanged()
    router.push(erpPath(`/teams/direct/${d.id}`))
  }

  return (
    <Box component="nav" aria-label={t('Teams')} sx={{ overflowY: 'auto', height: '100%', py: 1 }}>
      <NavItem href="/teams"><T text="All teams" /></NavItem>
      {teamId && (
        <>
          <Section title={t('Members')}>
            {members.map((m) => (
              <ListItem key={m.user_id} dense sx={{ gap: 1 }}>
                <PresenceDot status={statuses[m.user_id] ?? 'offline'} size={10} />
                <ListItemText primary={m.display_name} />
              </ListItem>
            ))}
            {owner && (
              <ListItemButton dense onClick={() => setManaging(true)}>
                <ListItemText primary={t('Manage members')} />
              </ListItemButton>
            )}
          </Section>
          <Section title={t('Channels')} action={owner && (
            <IconButton size="small" aria-label={t('Add channel')} onClick={() => { setDialogError(''); setNewChannel('') }}>+</IconButton>
          )}>
            {channels.map((c) => (
              <NavItem key={c.id} href={`/teams/${teamId}/channels/${c.id}`} selected={view.kind === 'channel' && view.id === c.id} unread={unread[c.id] ?? c.unread}>
                # {c.name}
              </NavItem>
            ))}
          </Section>
          {folders && (
            <Section title={t('Folders')}>
              <NavItem href={`/teams/${teamId}/files`} selected={view.kind === 'files' && !view.id}><T text="All files" /></NavItem>
              {folders.map((f) => <FolderNode key={f.id} teamId={teamId} folder={f} depth={0} />)}
            </Section>
          )}
        </>
      )}
      <NavItem href="/teams/shared" selected={view.kind === 'shared'}><T text="Shares" /></NavItem>
      <Section title={t('Direct messages')} action={
        <IconButton size="small" aria-label={t('New conversation')} onClick={() => { setDialogError(''); setNewDirect(true) }}>+</IconButton>
      }>
        {directs.map((d) => (
          <NavItem key={d.id} href={`/teams/direct/${d.id}`} selected={view.kind === 'direct' && view.id === d.id} unread={unread[d.id] ?? d.unread}>
            {d.other_user.display_name}
          </NavItem>
        ))}
      </Section>

      <Dialog open={newChannel !== null} onClose={() => setNewChannel(null)} fullWidth maxWidth="xs">
        <DialogTitle><T text="New channel" /></DialogTitle>
        <DialogContent>
          {dialogError && <Alert severity="error" sx={{ mb: 1 }}>{dialogError}</Alert>}
          <TextField autoFocus fullWidth label={t('Name')} value={newChannel ?? ''} onChange={(e) => setNewChannel(e.target.value)} sx={{ mt: 1 }} />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setNewChannel(null)}><T text="Cancel" /></Button>
          <Button variant="contained" disabled={!newChannel?.trim()} onClick={() => void addChannel().catch(fail)}><T text="Create" /></Button>
        </DialogActions>
      </Dialog>
      <Dialog open={newDirect} onClose={() => setNewDirect(false)} fullWidth maxWidth="xs">
        <DialogTitle><T text="New conversation" /></DialogTitle>
        <DialogContent sx={{ pt: '8px !important' }}>
          {dialogError && <Alert severity="error" sx={{ mb: 1 }}>{dialogError}</Alert>}
          <DirectoryPicker label={t('Person')} value={dmUser} onChange={setDmUser} />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setNewDirect(false)}><T text="Cancel" /></Button>
          <Button variant="contained" disabled={!dmUser} onClick={() => void startDirect().catch(fail)}><T text="Start" /></Button>
        </DialogActions>
      </Dialog>
      {teamId && owner && (
        <MembersDialog open={managing} teamId={teamId} members={members} onClose={() => setManaging(false)} onChanged={onChanged} />
      )}
    </Box>
  )
}
