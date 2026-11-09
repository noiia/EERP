'use client'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Link from '@mui/material/Link'
import Popover from '@mui/material/Popover'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { AvatarWithPresence, avatarUrl, T, useT } from '@eerp/core-front'
import { postMessage, toggleReaction, type Message } from './client'
import { useChatStore } from './chat-store'
import { Composer, type MentionCandidate } from './Composer'

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
      {m.attachments.map((a) => (
        <Box key={a.id}>
          <Link href={`/api/teams/attachments/${a.id}`} variant="body2">📄 {a.filename}</Link>
        </Box>
      ))}
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

export function ChatPane({
  channelId,
  title,
  members,
  canAttach,
  readOnly,
}: {
  channelId: string
  title: string
  members: MentionCandidate[]
  canAttach: boolean
  readOnly: boolean
}) {
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
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0 }}>
      <Typography variant="h6" component="h1" sx={{ px: 2, py: 1, borderBottom: 1, borderColor: 'divider' }}>{title}</Typography>
      <Box ref={scroller} onScroll={onScroll} sx={{ flex: 1, overflowY: 'auto', px: 2 }}>
        {messages.length === 0 && (
          <Typography color="text.secondary" sx={{ py: 2 }}><T text="No messages yet." /></Typography>
        )}
        {messages.map((m) => <MessageItem key={m.id} m={m} onReact={(e) => react(m.id, e)} />)}
      </Box>
      <Composer members={members} canAttach={canAttach} readOnly={readOnly} onSend={send} />
    </Box>
  )
}
