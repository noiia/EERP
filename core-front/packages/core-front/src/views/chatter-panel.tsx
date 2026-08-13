'use client'
import { useEffect, useRef, useState } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Card from '@mui/material/Card'
import CardContent from '@mui/material/CardContent'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useChatterOps, type ChatterMessageRecord } from './chatter-ops'
import { useT } from '../i18n/translate'
import { layout } from './tokens'
import { useUiStore } from './ui-store'

// The form chatter panel: a per-record activity feed — user-posted messages
// plus the form's own summary of an edit (renderers.tsx's FormRenderer posts
// a "log" entry after a successful update; see summarizeFieldChanges there).
// Sits beside the form on a wide screen, stacked below it on a narrow one
// (tokens.ts's `chatterBreakpoint`), resizable via a drag handle on its own
// left edge — a per-user layout preference persisted in useUiStore, shared
// across every entity (not per-entity like the list view's viewMode).
//
// Inert (renders nothing) with no ChatterOpsProvider mounted, the same
// "render inert, not a crash" posture every other Ops context takes.

const chatterMediaQuery = `@media (min-width:${layout.chatterBreakpoint}px)` as const

/**
 * Drag-to-resize the panel's own width from its LEFT edge (the panel sits at
 * the form's right). Plain mouse events — a single fixed-axis drag doesn't
 * earn a dependency; react-resizable ships only as react-grid-layout's own
 * internal, untyped-for-app-code peer (see layout.tsx's CSS-only import of
 * it), not a primitive this codebase's app code otherwise calls directly.
 */
function useHorizontalResize(width: number, setWidth: (w: number) => void, min: number, max: number) {
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null)

  useEffect(() => {
    function onMove(e: MouseEvent) {
      const drag = dragState.current
      if (!drag) return
      const next = drag.startWidth - (e.clientX - drag.startX)
      setWidth(Math.min(max, Math.max(min, next)))
    }
    function onUp() {
      dragState.current = null
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [min, max, setWidth])

  return {
    onMouseDown: (e: React.MouseEvent) => {
      dragState.current = { startX: e.clientX, startWidth: width }
      e.preventDefault()
    },
  }
}

function ChatterEntry({ message }: { message: ChatterMessageRecord }) {
  const isLog = message.kind === 'log'
  return (
    <Box sx={{ opacity: isLog ? 0.72 : 1 }}>
      <Typography variant="body2" component="span" sx={{ fontWeight: isLog ? 400 : 600 }}>
        {message.author}
      </Typography>
      <Typography variant="body2" component="span" color="text.secondary">
        {' : '}
      </Typography>
      <Typography variant="body2" component="span" sx={{ whiteSpace: 'pre-wrap' }}>
        {message.body}
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
        {new Date(message.createdAt).toLocaleString()}
      </Typography>
    </Box>
  )
}

export function ChatterPanel({ entity, recordId }: { entity: string; recordId?: string | null }) {
  const t = useT()
  const ops = useChatterOps()
  const width = useUiStore((s) => s.chatterWidth)
  const setWidth = useUiStore((s) => s.setChatterWidth)
  const { onMouseDown } = useHorizontalResize(width, setWidth, layout.chatterWidthMin, layout.chatterWidthMax)
  const [messages, setMessages] = useState<ChatterMessageRecord[]>([])
  const [draft, setDraft] = useState('')
  const [posting, setPosting] = useState(false)

  useEffect(() => {
    if (!ops || !recordId) return
    let cancelled = false
    ops
      .list(entity, recordId)
      .then((found) => {
        if (!cancelled) setMessages(found)
      })
      .catch(() => {
        if (!cancelled) setMessages([])
      })
    return () => {
      cancelled = true
    }
  }, [ops, entity, recordId])

  if (!ops) return null

  async function send() {
    const body = draft.trim()
    if (!ops || !recordId || !body) return
    setPosting(true)
    try {
      const created = await ops.create(entity, recordId, 'message', body)
      setMessages((prev) => [created, ...prev])
      setDraft('')
    } finally {
      setPosting(false)
    }
  }

  return (
    <Box
      sx={{
        position: 'relative',
        width: '100%',
        [chatterMediaQuery]: { width, flexShrink: 0 },
      }}
    >
      {/* Resize handle — only meaningful (and shown) once the panel sits
          beside the form; stacked below it on a narrow screen, dragging
          would have nothing to widen against. */}
      <Box
        onMouseDown={onMouseDown}
        sx={{
          display: 'none',
          [chatterMediaQuery]: {
            display: 'block',
            position: 'absolute',
            left: -6,
            top: 0,
            bottom: 0,
            width: 10,
            cursor: 'col-resize',
            zIndex: 1,
          },
        }}
      />
      <Card sx={{ height: '100%', [chatterMediaQuery]: { ml: 1.5 } }}>
        <CardContent>
          <Typography variant="subtitle1" sx={{ mb: 1.5 }}>
            {t('Activity')}
          </Typography>
          {!recordId ? (
            <Typography variant="body2" color="text.secondary">
              {t('Available once the record has been saved.')}
            </Typography>
          ) : (
            <Stack spacing={2}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-end' }}>
                <TextField
                  multiline
                  minRows={2}
                  maxRows={6}
                  fullWidth
                  size="small"
                  placeholder={t('Write a message…')}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  disabled={posting}
                />
                <Button variant="contained" disabled={!draft.trim() || posting} onClick={() => void send()}>
                  {t('Send')}
                </Button>
              </Stack>
              <Stack spacing={1.5} divider={<Box sx={{ borderTop: 1, borderColor: 'divider' }} />}>
                {messages.map((m) => (
                  <ChatterEntry key={m.id} message={m} />
                ))}
              </Stack>
            </Stack>
          )}
        </CardContent>
      </Card>
    </Box>
  )
}
