'use client'
import { useEffect, useLayoutEffect, useRef, useState, type DragEvent } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Drawer from '@mui/material/Drawer'
import Popover from '@mui/material/Popover'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import useMediaQuery from '@mui/material/useMediaQuery'
import { useTheme } from '@mui/material/styles'
import { AvatarWithPresence, avatarUrl, T, useT } from '@eerp/core-front'
import { postMessage, toggleReaction, type Message, type Role } from './client'
import { useChatStore } from './chat-store'
import { Composer, type MentionCandidate } from './Composer'
import { FolderPanel } from './FolderPanel'
import { ImageAttachments } from './ImageAttachments'

const PANEL_WIDTH = 360

export const REACTIONS = ['👍', '❤️', '😂', '🎉', '👀', '✅']
const NO_MESSAGES: Message[] = []

function MessageItem({ m, onReact }: { m: Message; onReact: (emoji: string) => void }) {
  const t = useT()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  return (
    <Box component="article" sx={{ py: 0.75 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <AvatarWithPresence userId={m.author_id} label={m.author_name} size={24} src={avatarUrl(m.author_id, m.author_has_avatar)} />
        <Typography variant="subtitle2" component="span">{m.author_name}</Typography>
        <Typography variant="caption" color="text.secondary">{new Date(m.created_at).toLocaleString()}</Typography>
      </Stack>
      {m.body && <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{m.body}</Typography>}
      <ImageAttachments attachments={m.attachments} />
      <Stack direction="row" spacing={0.5} sx={{ mt: 0.5, flexWrap: 'wrap', alignItems: 'center' }}>
        {m.reactions.map((r) => (
          <Chip
            key={r.emoji}
            size="small"
            label={`${r.emoji} ${r.count}`}
            color={r.mine ? 'primary' : 'default'}
            variant={r.mine ? 'filled' : 'outlined'}
            onClick={() => onReact(r.emoji)}
          />
        ))}
        <Button size="small" sx={{ minWidth: 0 }} aria-label={t('Add reaction')} onClick={(e) => setAnchor(e.currentTarget)}>☺</Button>
        <Popover open={anchor !== null} anchorEl={anchor} onClose={() => setAnchor(null)} anchorOrigin={{ vertical: 'top', horizontal: 'left' }} transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}>
          <Stack direction="row">
            {REACTIONS.map((e) => (
              <Button key={e} sx={{ minWidth: 40 }} onClick={() => { setAnchor(null); onReact(e) }}>{e}</Button>
            ))}
          </Stack>
        </Popover>
      </Stack>
    </Box>
  )
}

/** A conversation: its messages and composer, the whole pane a drop target for files, plus a
 * team channel's folder panel on the right (a drawer below md). */
export function ChatPane({
  channelId,
  title,
  members,
  canAttach,
  readOnly,
  teamId,
  folderId,
  role,
  foldersRev = 0,
  onFolderChanged,
  onFoldersChanged,
}: {
  channelId: string
  title: string
  members: MentionCandidate[]
  canAttach: boolean
  readOnly: boolean
  /** Set for a team channel only: enables the folder panel. */
  teamId?: string
  folderId?: string | null
  role?: Role
  foldersRev?: number
  /** The channel's folder may have changed: linked, or created/filled by files just sent. */
  onFolderChanged?: () => void
  /** A subfolder was created/renamed/deleted in the panel: the sidebar's folder tree reloads. */
  onFoldersChanged?: () => void
}) {
  const t = useT()
  const narrow = useMediaQuery(useTheme().breakpoints.down('md'))
  const [panel, setPanel] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [dropError, setDropError] = useState('')
  const messages = useChatStore((s) => s.messages[channelId] ?? NO_MESSAGES)
  const hasMore = useChatStore((s) => s.hasMore[channelId] ?? false)
  const scroller = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  const loadingOlder = useRef(false)
  // Scroll height before an older page was prepended, to keep the view in place.
  const heightBefore = useRef<number | null>(null)

  useEffect(() => {
    const { load, close } = useChatStore.getState()
    atBottom.current = true
    load(channelId).catch(() => {})
    return () => close(channelId)
  }, [channelId])

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    if (heightBefore.current !== null) {
      el.scrollTop += el.scrollHeight - heightBefore.current
      heightBefore.current = null
    } else if (atBottom.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [messages])

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    if (el.scrollTop < 40 && hasMore && !loadingOlder.current) {
      loadingOlder.current = true
      heightBefore.current = el.scrollHeight
      useChatStore.getState().loadOlder(channelId)
        .catch(() => { heightBefore.current = null })
        .finally(() => { loadingOlder.current = false })
    }
  }

  const react = (messageId: string, emoji: string) => {
    toggleReaction(messageId, emoji)
      .then(({ reactions }) => useChatStore.getState().applyReactions({ type: 'chat_reaction', channel_id: channelId, message_id: messageId, reactions }))
      .catch(() => {})
  }

  const send = async (body: string, mentions: string[], files: File[]) => {
    const m = await postMessage(channelId, body, mentions, files)
    atBottom.current = true
    useChatStore.getState().receive({ type: 'chat_message', channel_id: channelId, message: m })
    if (teamId && files.length > 0) onFolderChanged?.()
  }

  const droppable = canAttach && !readOnly
  const drop = {
    onDragOver: (e: DragEvent) => {
      if (!droppable || !e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
      setDragging(true)
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
    },
    onDrop: (e: DragEvent) => {
      setDragging(false)
      const files = Array.from(e.dataTransfer.files ?? [])
      if (!droppable || files.length === 0) return
      e.preventDefault()
      setDropError('')
      send('', [], files).catch((err: unknown) => setDropError(err instanceof Error && err.message ? err.message : t('The message could not be sent.')))
    },
  }

  const folderPanel = teamId && panel && (
    <FolderPanel key={`${folderId}:${foldersRev}`} teamId={teamId} channelId={channelId} folderId={folderId} role={role} onLinked={() => onFolderChanged?.()} onFoldersChanged={onFoldersChanged} />
  )

  return (
    <Box sx={{ display: 'flex', height: '100%', minWidth: 0 }}>
      <Box data-testid="teams-chat-pane" {...drop} sx={{
        display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0,
        outlineWidth: dragging ? 2 : 0, outlineStyle: 'dashed', outlineColor: 'primary.main', outlineOffset: -4,
      }}>
        <Stack direction="row" sx={{ px: 2, py: 1, borderBottom: 1, borderColor: 'divider', alignItems: 'center', justifyContent: 'space-between' }}>
          <Typography variant="h6" component="h1" noWrap>{title}</Typography>
          {teamId && (
            <Button size="small" variant={panel ? 'contained' : 'text'} aria-pressed={panel} onClick={() => setPanel(!panel)}><T text="Folder" /></Button>
          )}
        </Stack>
        <Box ref={scroller} onScroll={onScroll} sx={{ flex: 1, overflowY: 'auto', px: 2 }}>
          {messages.length === 0 && (
            <Typography color="text.secondary" sx={{ py: 2 }}><T text="No messages yet." /></Typography>
          )}
          {messages.map((m) => <MessageItem key={m.id} m={m} onReact={(e) => react(m.id, e)} />)}
        </Box>
        {dropError && <Typography color="error" variant="body2" sx={{ px: 2 }}>{dropError}</Typography>}
        <Composer members={members} canAttach={canAttach} readOnly={readOnly} onSend={send} />
      </Box>
      {folderPanel && (narrow
        ? <Drawer anchor="right" open onClose={() => setPanel(false)} slotProps={{ paper: { sx: { width: `min(${PANEL_WIDTH}px, 100vw)` } } }}>{folderPanel}</Drawer>
        : <Box sx={{ width: PANEL_WIDTH, flexShrink: 0, borderLeft: 1, borderColor: 'divider', minHeight: 0 }}>{folderPanel}</Box>)}
    </Box>
  )
}
