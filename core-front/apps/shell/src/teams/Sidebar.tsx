'use client'
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'
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
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { AvatarWithPresence, avatarUrl, erpPath, IntentLink, T, useBreadcrumbStore, useSessionStore, useT } from '@eerp/core-front'
import {
  createChannel, deleteChannel, deleteTeam, listFiles, openDirect, orderChannels, orderDirect, removeMember, renameChannel, updateTeam,
  type Channel, type DirectChat, type DirectoryUser, type Folder, type Member, type Role, type Team,
} from './client'
import { DirectoryPicker, MembersDialog } from './MembersDialog'

export type WorkspaceView = { kind: 'channel' | 'direct' | 'files' | 'shared'; id?: string }

// Team and channel management (owners; leaving is open to everyone).
type Action =
  | { kind: 'renameTeam' | 'deleteTeam' | 'leaveTeam' }
  | { kind: 'renameChannel' | 'deleteChannel'; channel: Channel }

function NavItem({ href, selected, unread = 0, children, indent = 0 }: { href: string; selected?: boolean; unread?: number; children: ReactNode; indent?: number }) {
  return (
    <ListItemButton component={IntentLink} href={erpPath(href)} selected={selected} onClick={() => useBreadcrumbStore.getState().reset()} dense sx={{ pl: 2 + indent * 2 }}>
      <ListItemText primary={children} />
      {unread > 0 && <Badge badgeContent={unread} color="primary" sx={{ mr: 1.5 }} />}
    </ListItemButton>
  )
}

// Locally ordered list: HTML5 drag-and-drop (as the Kanban renderer) or Alt+ArrowUp/Down on a
// focused item reorders at once, then saves; a rejected save puts the old order back.
function useReorder<T extends { id: string }>(items: T[], save: (ids: string[]) => Promise<unknown>, onError: (e: unknown) => void) {
  const [list, setList] = useState(items)
  useEffect(() => setList(items), [items])
  const dragged = useRef<string | null>(null)
  const moveTo = (id: string, to: number) => {
    const from = list.findIndex((x) => x.id === id)
    if (from < 0 || to < 0 || to >= list.length || from === to) return
    const next = [...list]
    next.splice(to, 0, next.splice(from, 1)[0])
    const prev = list
    setList(next)
    save(next.map((x) => x.id)).catch((e: unknown) => { setList(prev); onError(e) })
  }
  const itemProps = (id: string) => ({
    draggable: true,
    onDragStart: () => { dragged.current = id },
    onDragOver: (e: DragEvent) => e.preventDefault(),
    onDrop: (e: DragEvent) => {
      e.preventDefault()
      const from = dragged.current
      dragged.current = null
      if (from) moveTo(from, list.findIndex((x) => x.id === id))
    },
    onKeyDown: (e: KeyboardEvent) => {
      if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
      e.preventDefault()
      moveTo(id, list.findIndex((x) => x.id === id) + (e.key === 'ArrowUp' ? -1 : 1))
    },
  })
  return { list, itemProps }
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

export function Sidebar({ teamId, team, role, members, channels, directs, unread, view, onChanged, foldersRev = 0 }: {
  teamId?: string
  team?: Team | null
  role?: Role
  members: Member[]
  channels: Channel[]
  directs: DirectChat[]
  unread: Record<string, number>
  view: WorkspaceView
  onChanged: () => void
  /** Bumped after a folder mutation in the files pane: the folder tree reloads. */
  foldersRev?: number
}) {
  const t = useT()
  const router = useRouter()
  const me = useSessionStore((s) => s.identity?.userId)
  const [menu, setMenu] = useState<{ anchor: HTMLElement; channel?: Channel } | null>(null)
  const [action, setAction] = useState<Action | null>(null)
  const [newName, setNewName] = useState('')
  // null = no file storage (Go doesn't mount the files routes without S3): the section is hidden.
  const [folders, setFolders] = useState<Folder[] | null>(null)
  const [newChannel, setNewChannel] = useState<string | null>(null)
  const [newDirect, setNewDirect] = useState(false)
  const [dmUser, setDmUser] = useState<DirectoryUser | null>(null)
  const [managing, setManaging] = useState(false)
  const [dialogError, setDialogError] = useState('')
  const fail = (e: unknown) => setDialogError(e instanceof Error && e.message ? e.message : t('The change could not be saved.'))
  const owner = role === 'owner'
  const [orderError, setOrderError] = useState('')
  const orderFail = (e: unknown) => setOrderError(e instanceof Error && e.message ? e.message : t('The change could not be saved.'))
  const chans = useReorder(channels, (ids) => orderChannels(teamId ?? '', ids), orderFail)
  const dms = useReorder(directs, (ids) => orderDirect(ids), orderFail)

  useEffect(() => {
    if (!teamId) return
    listFiles(teamId).then((l) => setFolders(l.folders)).catch(() => setFolders(null))
  }, [teamId, foldersRev])

  const pick = (a: Action, name = '') => {
    setMenu(null)
    setDialogError('')
    setNewName(name)
    setAction(a)
  }
  const confirmAction = async () => {
    if (!teamId || !action) return
    switch (action.kind) {
      case 'renameTeam':
        await updateTeam(teamId, newName.trim(), team?.description ?? '')
        break
      case 'renameChannel':
        await renameChannel(teamId, action.channel.id, newName.trim())
        break
      case 'deleteChannel':
        await deleteChannel(teamId, action.channel.id)
        if (view.kind === 'channel' && view.id === action.channel.id) router.push(erpPath(`/teams/${teamId}`))
        break
      case 'deleteTeam':
      case 'leaveTeam':
        await (action.kind === 'deleteTeam' ? deleteTeam(teamId) : removeMember(teamId, me ?? ''))
        setAction(null)
        router.push(erpPath('/teams'))
        return
    }
    setAction(null)
    onChanged()
  }
  const renaming = action?.kind === 'renameTeam' || action?.kind === 'renameChannel'
  const actionTitle = action && {
    renameTeam: t('Rename team'),
    deleteTeam: t('Delete team'),
    leaveTeam: t('Leave team'),
    renameChannel: t('Rename channel'),
    deleteChannel: t('Delete channel'),
  }[action.kind]

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
      {orderError && <Alert severity="error" onClose={() => setOrderError('')} sx={{ mx: 1, my: 0.5 }}>{orderError}</Alert>}
      {teamId && (
        <>
          <Box sx={{ display: 'flex', alignItems: 'center', px: 2, pt: 1 }}>
            <Typography variant="subtitle2" noWrap sx={{ flex: 1 }}>{team?.name}</Typography>
            <IconButton size="small" aria-label={t('Team options')} onClick={(e) => setMenu({ anchor: e.currentTarget })}>⋮</IconButton>
          </Box>
          <Section title={t('Members')}>
            {members.map((m) => (
              <ListItem key={m.user_id} dense sx={{ gap: 1 }}>
                <AvatarWithPresence userId={m.user_id} label={m.display_name} size={24} src={avatarUrl(m.user_id, m.has_avatar)} />
                <ListItemText primary={m.display_name || t('Disabled user')} />
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
            {chans.list.map((c) => (
              <Box key={c.id} {...chans.itemProps(c.id)} sx={{ display: 'flex', alignItems: 'center' }}>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <NavItem href={`/teams/${teamId}/channels/${c.id}`} selected={view.kind === 'channel' && view.id === c.id} unread={unread[c.id] ?? c.unread}>
                    # {c.name}
                  </NavItem>
                </Box>
                {owner && (
                  <IconButton size="small" aria-label={`${t('Channel options')} #${c.name}`} onClick={(e) => setMenu({ anchor: e.currentTarget, channel: c })}>⋮</IconButton>
                )}
              </Box>
            ))}
          </Section>
          {folders && (
            <Section title={t('Folders')}>
              <NavItem href={`/teams/${teamId}/files`} selected={view.kind === 'files' && !view.id}><T text="All files" /></NavItem>
              {/* the rev in the key remounts the nodes, so expanded subfolders re-read too */}
              {folders.map((f) => <FolderNode key={`${f.id}:${foldersRev}`} teamId={teamId} folder={f} depth={0} />)}
            </Section>
          )}
        </>
      )}
      <NavItem href="/teams/shared" selected={view.kind === 'shared'}><T text="Shares" /></NavItem>
      <Section title={t('Direct messages')} action={
        <IconButton size="small" aria-label={t('New conversation')} onClick={() => { setDialogError(''); setNewDirect(true) }}>+</IconButton>
      }>
        {dms.list.map((d) => (
          <Box key={d.id} {...dms.itemProps(d.id)}>
          <NavItem href={`/teams/direct/${d.id}`} selected={view.kind === 'direct' && view.id === d.id} unread={unread[d.id] ?? d.unread}>
            <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}>
              <AvatarWithPresence userId={d.other_user.id} label={d.other_user.display_name} size={24} src={avatarUrl(d.other_user.id, d.other_user.has_avatar)} />
              {d.other_user.display_name}
            </Box>
          </NavItem>
          </Box>
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
      <Menu anchorEl={menu?.anchor} open={!!menu} onClose={() => setMenu(null)}>
        {menu?.channel ? [
          <MenuItem key="rename" onClick={() => pick({ kind: 'renameChannel', channel: menu.channel! }, menu.channel!.name)}><T text="Rename channel" /></MenuItem>,
          <MenuItem key="delete" onClick={() => pick({ kind: 'deleteChannel', channel: menu.channel! })}><T text="Delete channel" /></MenuItem>,
        ] : [
          ...(owner ? [
            <MenuItem key="rename" onClick={() => pick({ kind: 'renameTeam' }, team?.name ?? '')}><T text="Rename team" /></MenuItem>,
            <MenuItem key="delete" onClick={() => pick({ kind: 'deleteTeam' })}><T text="Delete team" /></MenuItem>,
          ] : []),
          <MenuItem key="leave" onClick={() => pick({ kind: 'leaveTeam' })}><T text="Leave team" /></MenuItem>,
        ]}
      </Menu>
      <Dialog open={!!action} onClose={() => setAction(null)} fullWidth maxWidth="xs">
        <DialogTitle>{actionTitle}</DialogTitle>
        <DialogContent>
          {dialogError && <Alert severity="error" sx={{ mb: 1 }}>{dialogError}</Alert>}
          {renaming
            ? <TextField autoFocus fullWidth label={t('Name')} value={newName} onChange={(e) => setNewName(e.target.value)} sx={{ mt: 1 }} />
            : <Typography><T text="Are you sure?" /> {action?.kind === 'deleteTeam' || action?.kind === 'deleteChannel' ? t('This cannot be undone.') : ''}</Typography>}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAction(null)}><T text="Cancel" /></Button>
          <Button variant="contained" color={renaming ? 'primary' : 'error'} disabled={renaming && !newName.trim()} onClick={() => void confirmAction().catch(fail)}>
            {renaming ? <T text="Save" /> : <T text="Confirm" />}
          </Button>
        </DialogActions>
      </Dialog>
      {teamId && owner && (
        <MembersDialog open={managing} teamId={teamId} members={members} onClose={() => setManaging(false)} onChanged={onChanged} />
      )}
    </Box>
  )
}
