'use client'
import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react'
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

/** A formatting-panel button: `wrap` surrounds the selection, `line` prefixes each selected line. */
interface Pattern {
  label: string
  title: string
  wrap?: [string, string]
  line?: (index: number) => string
}

export const PATTERNS: Pattern[] = [
  { label: 'H', title: 'Title', line: () => '## ' },
  { label: 'B', title: 'Bold', wrap: ['**', '**'] },
  { label: 'I', title: 'Italic', wrap: ['*', '*'] },
  { label: 'S', title: 'Strikethrough', wrap: ['~~', '~~'] },
  { label: '</>', title: 'Code', wrap: ['`', '`'] },
  { label: '{ }', title: 'Code block', wrap: ['```\n', '\n```'] },
  { label: '❝', title: 'Quote', line: () => '> ' },
  { label: '•', title: 'Bulleted list', line: () => '- ' },
  { label: '1.', title: 'Numbered list', line: (i) => `${i + 1}. ` },
  { label: '🔗', title: 'Link', wrap: ['[', '](https://)'] },
]

/** `text` with `p` applied to [start, end), and the range to select afterwards. */
export function applyPattern(text: string, start: number, end: number, p: Pattern): { text: string; start: number; end: number } {
  if (p.line) {
    const from = text.lastIndexOf('\n', start - 1) + 1
    const lines = text.slice(from, end).split('\n').map((l, i) => p.line!(i) + l)
    const block = lines.join('\n')
    return { text: text.slice(0, from) + block + text.slice(end), start: start + p.line(0).length, end: from + block.length }
  }
  const [before, after] = p.wrap!
  const s = start + before.length
  return { text: text.slice(0, start) + before + text.slice(start, end) + after + text.slice(end), start: s, end: s + end - start }
}

// The `@query` being typed right before the caret, if any.
const MENTION_AT_CARET = /(^|\s)@([^\s@]*)$/

export function Composer({
  members,
  canAttach,
  readOnly = false,
  onSend,
  dropped,
}: {
  members: MentionCandidate[]
  canAttach: boolean
  readOnly?: boolean
  onSend: (body: string, mentions: string[], files: File[]) => Promise<void>
  /** Files dropped on the conversation: added to the pending ones, sent with the next message. */
  dropped?: File[]
}) {
  const t = useT()
  const [text, setText] = useState('')
  const [caret, setCaret] = useState(0)
  const [mentions, setMentions] = useState<MentionCandidate[]>([])
  const [files, setFiles] = useState<File[]>([])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [formatting, setFormatting] = useState(false)
  const selection = useRef<[number, number] | null>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const filePicker = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!dropped?.length) return
    setFiles((cur) => [...cur, ...dropped])
    input.current?.focus()
  }, [dropped])

  // Restores the selection a pattern asked for once React has written the new text.
  useLayoutEffect(() => {
    if (!selection.current || !input.current) return
    input.current.focus()
    input.current.setSelectionRange(...selection.current)
    selection.current = null
  }, [text])

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

  const format = (p: Pattern) => {
    const el = input.current
    const next = applyPattern(text, el?.selectionStart ?? text.length, el?.selectionEnd ?? text.length, p)
    selection.current = [next.start, next.end]
    setText(next.text)
    setCaret(next.start)
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
    // With the formatting panel open, Enter is a new line and Ctrl/Cmd+Enter sends.
    if (e.key === 'Enter' && (formatting ? e.ctrlKey || e.metaKey : !e.shiftKey)) {
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
      {formatting && (
        <Stack direction="row" role="toolbar" aria-label={t('Formatting')} sx={{ mb: 1, flexWrap: 'wrap', gap: 0.5 }}>
          {PATTERNS.map((p) => (
            <Button
              key={p.title}
              size="small"
              variant="outlined"
              title={t(p.title)}
              aria-label={t(p.title)}
              sx={{ minWidth: 36, fontWeight: p.title === 'Bold' ? 700 : undefined, fontStyle: p.title === 'Italic' ? 'italic' : undefined, textDecoration: p.title === 'Strikethrough' ? 'line-through' : undefined, textTransform: 'none' }}
              // Keep the textarea's selection: a click would otherwise blur it first.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => format(p)}
            >
              {p.label}
            </Button>
          ))}
        </Stack>
      )}
      <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-end' }}>
        <Button
          aria-label={t('Format text')}
          title={t('Format text')}
          aria-pressed={formatting}
          variant={formatting ? 'contained' : 'text'}
          sx={{ minWidth: 40, textTransform: 'none' }}
          onClick={() => {
            setFormatting(!formatting)
            input.current?.focus()
          }}
        >
          Aa
        </Button>
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
          placeholder={t(formatting ? 'Write a message (Ctrl+Enter to send)' : 'Write a message')}
          slotProps={{ htmlInput: { 'aria-label': t('Message') } }}
          multiline
          minRows={formatting ? 6 : 1}
          maxRows={formatting ? 20 : 8}
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
