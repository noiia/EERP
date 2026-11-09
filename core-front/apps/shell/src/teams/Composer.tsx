'use client'
import { useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import List from '@mui/material/List'
import ListItemButton from '@mui/material/ListItemButton'
import Paper from '@mui/material/Paper'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { T, useT } from '@eerp/core-front'

export interface MentionCandidate {
  user_id: string
  display_name: string
}

// The `@query` being typed right before the caret, if any.
const MENTION_AT_CARET = /(^|\s)@([^\s@]*)$/

export function Composer({
  members,
  canAttach,
  readOnly = false,
  onSend,
}: {
  members: MentionCandidate[]
  canAttach: boolean
  readOnly?: boolean
  onSend: (body: string, mentions: string[], files: File[]) => Promise<void>
}) {
  const t = useT()
  const [text, setText] = useState('')
  const [caret, setCaret] = useState(0)
  const [mentions, setMentions] = useState<MentionCandidate[]>([])
  const [files, setFiles] = useState<File[]>([])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const input = useRef<HTMLTextAreaElement>(null)
  const filePicker = useRef<HTMLInputElement>(null)

  if (readOnly) {
    return (
      <Typography color="text.secondary" sx={{ p: 2, borderTop: 1, borderColor: 'divider' }}>
        <T text="Guests have read only access to this channel." />
      </Typography>
    )
  }

  const query = MENTION_AT_CARET.exec(text.slice(0, caret))?.[2]
  const matches = query === undefined ? [] : members.filter((m) => m.display_name.toLowerCase().includes(query.toLowerCase())).slice(0, 6)

  const onChange = (e: ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    setText(e.target.value)
    setCaret(e.target.selectionStart ?? e.target.value.length)
  }

  const pick = (m: MentionCandidate) => {
    const before = text.slice(0, caret).replace(/@[^\s@]*$/, `@${m.display_name} `)
    setText(before + text.slice(caret))
    setCaret(before.length)
    setMentions((cur) => (cur.some((x) => x.user_id === m.user_id) ? cur : [...cur, m]))
    input.current?.focus()
  }

  const send = async () => {
    const body = text.trim()
    if ((!body && files.length === 0) || sending) return
    setSending(true)
    setError('')
    try {
      // A mention whose @Name was edited out of the text is not sent.
      await onSend(body, mentions.filter((m) => body.includes(`@${m.display_name}`)).map((m) => m.user_id), files)
      setText('')
      setCaret(0)
      setMentions([])
      setFiles([])
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : t('The message could not be sent.'))
    } finally {
      setSending(false)
    }
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  return (
    <Box sx={{ p: 1.5, borderTop: 1, borderColor: 'divider', position: 'relative' }}>
      {matches.length > 0 && (
        <Paper elevation={4} sx={{ position: 'absolute', bottom: '100%', left: 12, minWidth: 200, zIndex: 1 }}>
          <List dense role="listbox" aria-label={t('Mention someone')}>
            {matches.map((m) => (
              <ListItemButton key={m.user_id} role="option" aria-selected={false} onClick={() => pick(m)}>
                {m.display_name}
              </ListItemButton>
            ))}
          </List>
        </Paper>
      )}
      {files.length > 0 && (
        <Stack direction="row" spacing={1} sx={{ mb: 1, flexWrap: 'wrap' }}>
          {files.map((f, i) => (
            <Chip key={`${f.name}-${i}`} label={f.name} size="small" onDelete={() => setFiles(files.filter((_, j) => j !== i))} />
          ))}
        </Stack>
      )}
      <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-end' }}>
        {canAttach && (
          <>
            <Button aria-label={t('Attach files')} onClick={() => filePicker.current?.click()}>
              📎
            </Button>
            <input
              ref={filePicker}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                setFiles([...files, ...Array.from(e.target.files ?? [])])
                e.target.value = ''
              }}
            />
          </>
        )}
        <TextField
          inputRef={input}
          value={text}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? text.length)}
          placeholder={t('Write a message')}
          slotProps={{ htmlInput: { 'aria-label': t('Message') } }}
          multiline
          maxRows={8}
          size="small"
          fullWidth
          error={Boolean(error)}
          helperText={error || undefined}
        />
        <Button variant="contained" onClick={() => void send()} disabled={sending}>
          <T text="Send" />
        </Button>
      </Stack>
    </Box>
  )
}
