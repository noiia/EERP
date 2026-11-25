'use client'
import { useEffect, useLayoutEffect, useRef, useState, type DragEvent } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Drawer from '@mui/material/Drawer'
import IconButton from '@mui/material/IconButton'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Popover from '@mui/material/Popover'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import useMediaQuery from '@mui/material/useMediaQuery'
import { useTheme } from '@mui/material/styles'
import { faFaceSmile } from '@fortawesome/free-regular-svg-icons'
import { faEllipsis, faReply } from '@fortawesome/free-solid-svg-icons'
import { AvatarWithPresence, avatarUrl, FontAwesomeIcon, T, useSessionStore, useT } from '@eerp/core-front'
import { deleteMessage, editMessage, postMessage, setCheck, toggleReaction, type Message, type Role } from './client'
import { useChatStore } from './chat-store'
import { Composer, type MentionCandidate } from './Composer'
import { FolderPanel } from './FolderPanel'
import { ImageAttachments } from './ImageAttachments'
import { Markdown } from './Markdown'

const PANEL_WIDTH = 360

export const REACTIONS = ['👍', '❤️', '😂', '🎉', '👀', '✅']
const NO_MESSAGES: Message[] = []

/** A message goes under the previous one, without its own author line, when the same
 * person sent both and at most this long apart; another author or a longer gap starts a new group. */
export const STACK_GAP_MS = 6 * 60 * 60 * 1000
export function stacksOnPrevious(prev: Message | undefined, m: Message): boolean {
  if (!prev || prev.author_id !== m.author_id) return false
  const gap = Date.parse(m.created_at) - Date.parse(prev.created_at)
  return Number.isFinite(gap) && gap <= STACK_GAP_MS
}

/** The inline editor of a message's body: Ctrl/Cmd+Enter saves, Escape cancels; a refusal stays in it. */
function MessageEditor({ initial, onSave, onCancel }: { initial: string; onSave: (body: string) => Promise<void>; onCancel: () => void }) {
  const t = useT()
  const [draft, setDraft] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const save = () => {
    if (busy) return
    setBusy(true)
    setError('')
    onSave(draft).catch((err: unknown) => {
      setError(err instanceof Error && err.message ? err.message : t('The message could not be modified.'))
      setBusy(false)
    })
  }
  return (
    <Box sx={{ mt: 0.5 }}>
      <TextField
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); onCancel() }
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save() }
        }}
        multiline
        minRows={1}
        maxRows={12}
        fullWidth
        size="small"
        autoFocus
        disabled={busy}
        error={!!error}
        helperText={error || undefined}
        slotProps={{ htmlInput: { 'aria-label': t('Message to modify'), maxLength: 4000 } }}
      />
      <Stack direction="row" spacing={1} sx={{ mt: 0.5 }}>
        <Button size="small" variant="contained" onClick={save} disabled={busy}><T text="Save" /></Button>
        <Button size="small" onClick={onCancel} disabled={busy}><T text="Cancel" /></Button>
      </Stack>
    </Box>
  )
}

/** The answered message above a reply; a click scrolls to it when it is loaded. */
function ReplyQuote({ reply }: { reply: NonNullable<Message['reply_to']> }) {
  const t = useT()
  const jump = () => {
    const el = document.getElementById(`message-${reply.id}`)
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    el?.focus({ preventScroll: true })
  }
  return (
    <Box
      component="button"
      type="button"
      onClick={jump}
      disabled={reply.deleted}
      aria-label={t('Go to the answered message')}
      sx={{
        display: 'block', maxWidth: '100%', textAlign: 'left', font: 'inherit', fontSize: '0.85rem', color: 'text.secondary',
        bgcolor: 'transparent', border: 0, borderLeft: 3, borderColor: 'divider', pl: 1, py: 0, my: 0.25,
        cursor: reply.deleted ? 'default' : 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}
    >
      ↪ {reply.deleted ? t('Deleted message') : <><strong>{reply.author_name}</strong> {reply.body}</>}
    </Box>
  )
}

const GUTTER = 72 // px: the avatar column, as on Discord
const QUICK_REACTIONS = REACTIONS.slice(0, 3)
const hm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

// Hidden but still focusable (opacity, not visibility), so tabbing into the toolbar reveals it.
const toolbarSx = {
  position: 'absolute', top: -16, right: 16, zIndex: 1, display: 'flex', alignItems: 'center', gap: 0.25, p: 0.25,
  bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 1, boxShadow: 2,
  opacity: 0, pointerEvents: 'none',
} as const

/** One message, Discord style: a full-width row highlighted on hover, the avatar in a left gutter, and a
 * floating toolbar (quick reactions, the reaction picker, the options menu) on its top-right corner,
 * shown on hover, keyboard focus, or a tap (the row is click-focusable). */
function MessageItem({ m, stacked = false, onReact, onReply, onEdit, onDelete, onCheck }: { m: Message; stacked?: boolean; onReact: (emoji: string) => void; onReply?: () => void; onEdit?: (body: string) => Promise<void>; onDelete?: () => void; onCheck?: (index: number, checked: boolean) => void }) {
  const t = useT()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [menu, setMenu] = useState<HTMLElement | null>(null)
  const [editing, setEditing] = useState(false)
  const sentAt = new Date(m.created_at).toLocaleString()
  const edited = m.edited_at ? <Typography variant="caption" color="text.secondary" sx={{ ml: 0.5 }} title={new Date(m.edited_at).toLocaleString()}>{t('(edited)')}</Typography> : null
  const iconSx = { minWidth: 32, width: 32, height: 32, p: 0, fontSize: '1.1rem', color: 'text.secondary' }
  const open = anchor !== null || menu !== null
  return (
    <Box
      component="article"
      id={`message-${m.id}`}
      tabIndex={-1}
      data-stacked={stacked || undefined}
      title={stacked ? sentAt : undefined}
      sx={{
        position: 'relative', pl: `${GUTTER}px`, pr: 2, mt: stacked ? 0 : 2, py: 0.25, minHeight: stacked ? undefined : 44,
        outline: 'none', bgcolor: open ? 'action.hover' : undefined,
        '&:hover, &:focus-within': { bgcolor: 'action.hover' },
        '&:hover .message-toolbar, &:focus-within .message-toolbar': { opacity: 1, pointerEvents: 'auto' },
        ...(open && { '& .message-toolbar': { opacity: 1, pointerEvents: 'auto' } }),
        '&:hover .message-time': { opacity: 1 },
      }}
    >
      {stacked ? (
        <Typography className="message-time" variant="caption" color="text.secondary" sx={{ position: 'absolute', left: 0, width: GUTTER, textAlign: 'center', top: 6, fontSize: '0.7rem', opacity: 0 }}>{hm(m.created_at)}</Typography>
      ) : (
        <>
          <Box sx={{ position: 'absolute', left: 16, top: 4 }}>
            <AvatarWithPresence userId={m.author_id} label={m.author_name} size={40} src={avatarUrl(m.author_id, m.author_has_avatar)} />
          </Box>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline' }}>
            <Typography component="span" sx={{ fontWeight: 600, fontSize: '1rem' }}>{m.author_name}</Typography>
            <Typography variant="caption" color="text.secondary" title={sentAt}>{sentAt}</Typography>
          </Stack>
        </>
      )}
      {m.reply_to && <ReplyQuote reply={m.reply_to} />}
      {editing && onEdit ? (
        <MessageEditor initial={m.body} onCancel={() => setEditing(false)} onSave={(body) => onEdit(body).then(() => setEditing(false))} />
      ) : (
        <>
          {m.body && <Markdown text={m.body} onToggle={onCheck} />}
          {edited}
        </>
      )}
      <ImageAttachments attachments={m.attachments} />
      {m.reactions.length > 0 && (
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
        </Stack>
      )}
      <Box className="message-toolbar" role="toolbar" aria-label={t('Message actions')} sx={toolbarSx}>
        {QUICK_REACTIONS.map((e) => (
          <Button key={e} sx={iconSx} aria-label={`${t('React with')} ${e}`} onClick={() => onReact(e)}>{e}</Button>
        ))}
        <Box sx={{ width: '1px', alignSelf: 'stretch', bgcolor: 'divider', mx: 0.25 }} />
        <IconButton sx={iconSx} aria-label={t('Add reaction')} onClick={(e) => setAnchor(e.currentTarget)}>
          <FontAwesomeIcon icon={faFaceSmile} />
        </IconButton>
        {onReply && (
          <IconButton sx={iconSx} aria-label={t('Reply')} title={t('Reply')} onClick={onReply}>
            <FontAwesomeIcon icon={faReply} />
          </IconButton>
        )}
        {(onEdit || onDelete) && (
          <IconButton sx={iconSx} aria-label={t('Message options')} aria-haspopup="menu" aria-expanded={menu !== null} onClick={(e) => setMenu(e.currentTarget)}>
            <FontAwesomeIcon icon={faEllipsis} />
          </IconButton>
        )}
      </Box>
      <Popover open={anchor !== null} anchorEl={anchor} onClose={() => setAnchor(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }} transformOrigin={{ vertical: 'top', horizontal: 'right' }}>
        <Stack direction="row">
          {REACTIONS.map((e) => (
            <Button key={e} sx={{ minWidth: 40, fontSize: '1.25rem' }} onClick={() => { setAnchor(null); onReact(e) }}>{e}</Button>
          ))}
        </Stack>
      </Popover>
      <Menu anchorEl={menu} open={menu !== null} onClose={() => setMenu(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }} transformOrigin={{ vertical: 'top', horizontal: 'right' }}>
        {onEdit && <MenuItem onClick={() => { setMenu(null); setEditing(true) }}><T text="Modify message" /></MenuItem>}
        {onDelete && <MenuItem onClick={() => { setMenu(null); onDelete() }} sx={{ color: 'error.main' }}><T text="Delete message" /></MenuItem>}
      </Menu>
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
  const [actionError, setActionError] = useState('')
  // Files dropped on the pane wait in the composer; a new array per drop.
  const [dropped, setDropped] = useState<File[]>([])
  const [replyTo, setReplyTo] = useState<Message | null>(null)
  const me = useSessionStore((s) => s.identity?.userId)
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

  const remove = (messageId: string) => {
    setActionError('')
    deleteMessage(messageId)
      .then(() => useChatStore.getState().remove({ type: 'chat_message_deleted', channel_id: channelId, message_id: messageId }))
      .catch((err: unknown) => setActionError(err instanceof Error && err.message ? err.message : t('The message could not be deleted.')))
  }

  const check = (messageId: string, index: number, checked: boolean) => {
    setActionError('')
    setCheck(messageId, index, checked)
      .then((m) => useChatStore.getState().update({ type: 'chat_message_updated', channel_id: channelId, message: m }))
      .catch((err: unknown) => setActionError(err instanceof Error && err.message ? err.message : t('The checkbox could not be changed.')))
  }

  // Throws to the editor, which keeps the draft and shows Go's refusal.
  const edit = async (messageId: string, body: string) => {
    const m = await editMessage(messageId, body)
    useChatStore.getState().update({ type: 'chat_message_updated', channel_id: channelId, message: m })
  }

  const send = async (body: string, mentions: string[], files: File[]) => {
    const m = await postMessage(channelId, body, mentions, files, replyTo?.id)
    setReplyTo(null)
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
      setDropped(files)
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
        <Box ref={scroller} onScroll={onScroll} sx={{ flex: 1, overflowY: 'auto', pt: 2, pb: 1 }}>
          {messages.length === 0 && (
            <Typography color="text.secondary" sx={{ py: 2, px: 2 }}><T text="No messages yet." /></Typography>
          )}
          {messages.map((m, i) => (
            <MessageItem
              key={m.id}
              m={m}
              stacked={!m.reply_to && stacksOnPrevious(messages[i - 1], m)}
              onReact={(e) => react(m.id, e)}
              onReply={readOnly ? undefined : () => setReplyTo(m)}
              // Go's rule: only its author (not a guest) rewrites a message.
              onEdit={!readOnly && m.author_id === me ? (body) => edit(m.id, body) : undefined}
              // Go's rule: the author (not a guest) or a team owner.
              onDelete={!readOnly && (m.author_id === me || role === 'owner') ? () => remove(m.id) : undefined}
              // Go's rule: anyone who may react (not a guest) ticks a box, not only the author.
              onCheck={readOnly ? undefined : (index, checked) => check(m.id, index, checked)}
            />
          ))}
        </Box>
        {actionError && <Typography color="error" variant="body2" sx={{ px: 2 }}>{actionError}</Typography>}
        <Composer members={members} canAttach={canAttach} readOnly={readOnly} onSend={send} dropped={dropped} replyTo={replyTo} onCancelReply={() => setReplyTo(null)} />
      </Box>
      {folderPanel && (narrow
        ? <Drawer anchor="right" open onClose={() => setPanel(false)} slotProps={{ paper: { sx: { width: `min(${PANEL_WIDTH}px, 100vw)` } } }}>{folderPanel}</Drawer>
        : <Box sx={{ width: PANEL_WIDTH, flexShrink: 0, borderLeft: 1, borderColor: 'divider', minHeight: 0 }}>{folderPanel}</Box>)}
    </Box>
  )
}
