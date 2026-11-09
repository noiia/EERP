'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Drawer from '@mui/material/Drawer'
import Typography from '@mui/material/Typography'
import useMediaQuery from '@mui/material/useMediaQuery'
import { layout, onChatFrame, onLiveReconnect, T, useSessionStore, useT } from '@eerp/core-front'
import { getTeam, listChannels, listDirect, listMembers, listShared, type Channel, type DirectChat, type Member, type Team } from './client'
import { useChatStore, type ChatMessageFrame, type ChatReactionFrame } from './chat-store'
import { ChatPane } from './ChatPane'
import { FilesPane } from './FilesPane'
import { SharedPane } from './SharedPane'
import { Sidebar, type WorkspaceView } from './Sidebar'

// The shell's top bar is a dense MUI Toolbar (AppTopBar.tsx), 48px tall.
const TOP_BAR = 48
const SIDEBAR_WIDTH = 260

export function TeamsWorkspace({ teamId, view }: { teamId?: string; view: WorkspaceView }) {
  const t = useT()
  const me = useSessionStore((s) => s.identity?.userId)
  const phone = useMediaQuery(`(max-width:${layout.phoneMaxWidth - 0.05}px)`)
  const [drawer, setDrawer] = useState(false)
  const [team, setTeam] = useState<Team | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  const [channels, setChannels] = useState<Channel[]>([])
  const [directs, setDirects] = useState<DirectChat[]>([])
  // Attachments need file storage; Go mounts /shared only when S3 is configured.
  const [canAttach, setCanAttach] = useState(false)
  const [foldersRev, setFoldersRev] = useState(0)
  const unread = useChatStore((s) => s.unread)
  const directIds = useRef(new Set<string>())

  const reloadDirects = useCallback(() => {
    listDirect().then((d) => {
      setDirects(d)
      directIds.current = new Set(d.map((x) => x.id))
      useChatStore.getState().setUnread(Object.fromEntries(d.map((x) => [x.id, x.unread])))
    }).catch(() => {})
  }, [])

  const reload = useCallback(() => {
    reloadDirects()
    if (!teamId) return
    getTeam(teamId).then(setTeam).catch(() => setTeam(null))
    listMembers(teamId).then(setMembers).catch(() => setMembers([]))
    listChannels(teamId).then((c) => {
      setChannels(c)
      useChatStore.getState().setUnread(Object.fromEntries(c.map((x) => [x.id, x.unread])))
    }).catch(() => setChannels([]))
  }, [teamId, reloadDirects])

  useEffect(reload, [reload])
  useEffect(() => {
    listShared().then(() => setCanAttach(true), () => setCanAttach(false))
  }, [])

  useEffect(() => onChatFrame((f) => {
    const store = useChatStore.getState()
    if (f.type === 'chat_reaction') return store.applyReactions(f as unknown as ChatReactionFrame)
    const frame = f as unknown as ChatMessageFrame
    store.receive(frame)
    // A first message in a conversation this sidebar doesn't list yet.
    if (!frame.team_id && !directIds.current.has(frame.channel_id)) reloadDirects()
  }), [reloadDirects])

  // Frames sent while the socket was down are not replayed: re-read the sidebar and the open channel.
  useEffect(() => onLiveReconnect(() => {
    reload()
    const open = useChatStore.getState().open
    if (open) useChatStore.getState().load(open).catch(() => {})
  }), [reload])

  // Close the drawer after navigating from it.
  useEffect(() => setDrawer(false), [view.kind, view.id])

  const direct = view.kind === 'direct' ? directs.find((d) => d.id === view.id) : undefined
  const channel = view.kind === 'channel' ? channels.find((c) => c.id === view.id) : undefined
  const candidates = (direct ? [{ user_id: direct.other_user.id, display_name: direct.other_user.display_name }] : members)
    .filter((m) => m.user_id !== me)

  let main
  if ((view.kind === 'channel' || view.kind === 'direct') && view.id) {
    main = (
      <ChatPane
        key={view.id}
        channelId={view.id}
        title={direct ? direct.other_user.display_name : channel ? `# ${channel.name}` : ''}
        members={candidates}
        canAttach={canAttach}
        readOnly={view.kind === 'channel' && team?.role === 'guest'}
      />
    )
  } else if (view.kind === 'files' && teamId) {
    main = <FilesPane teamId={teamId} folderId={view.id} role={team?.role} onFoldersChanged={() => setFoldersRev((n) => n + 1)} />
  } else if (view.kind === 'shared') {
    main = <SharedPane />
  } else {
    main = (
      <Typography color="text.secondary" sx={{ p: 3 }}>
        <T text={view.kind === 'direct' ? 'Start a conversation with the + next to Direct messages.' : 'This team has no channel yet.'} />
      </Typography>
    )
  }

  const sidebar = (
    <Sidebar teamId={teamId} team={team} role={team?.role} foldersRev={foldersRev} members={members} channels={channels} directs={directs} unread={unread} view={view} onChanged={reload} />
  )

  return (
    <Box sx={{
      // Full bleed: cancel the ERP page inset and fill the viewport under the top bar.
      mx: `calc(-1 * ${layout.pageInsetX})`,
      my: `calc(-1 * ${layout.pageInsetY})`,
      height: `calc(100dvh - ${TOP_BAR}px)`,
      display: 'flex',
      flexDirection: phone ? 'column' : 'row',
    }}>
      {phone ? (
        <>
          <Box sx={{ borderBottom: 1, borderColor: 'divider', px: 1 }}>
            <Button onClick={() => setDrawer(true)} aria-label={t('Open the sidebar')}>☰ {team?.name ?? t('Teams')}</Button>
          </Box>
          <Drawer open={drawer} onClose={() => setDrawer(false)} slotProps={{ paper: { sx: { width: SIDEBAR_WIDTH, top: TOP_BAR, height: `calc(100% - ${TOP_BAR}px)` } } }}>
            {sidebar}
          </Drawer>
        </>
      ) : (
        <Box sx={{ width: SIDEBAR_WIDTH, flexShrink: 0, borderRight: 1, borderColor: 'divider' }}>{sidebar}</Box>
      )}
      <Box sx={{ flex: 1, minWidth: 0, minHeight: 0 }}>{main}</Box>
    </Box>
  )
}
