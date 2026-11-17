'use client'
import { useEffect, useMemo, useState } from 'react'
import Box from '@mui/material/Box'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { EditorContent, useEditor, useEditorState } from '@tiptap/react'
import { useT } from '../i18n/translate'
import { ViewBanner } from './banner'
import { ocNoteExtensions, parseOcNote } from './ocnote-document'
import { OcNoteToolbar } from './ocnote-toolbar'
import { OcNoteOutline, OcNoteSearch, type NoteHeading } from './ocnote-panels'

export { parseOcNote } from './ocnote-document'

export interface OcNoteEditorProps {
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  locked?: boolean
  name?: string
  onValidityChange?: (valid: boolean) => void
}

const printStyles = `body{font-family:Arial,sans-serif;color:#172033;line-height:1.7;margin:32px auto;max-width:920px}h1,h2,h3,h4,h5,h6{line-height:1.25;break-after:avoid}img{max-width:100%;height:auto}table{border-collapse:collapse;width:100%;font-size:14px}td,th{border:1px solid #cbd5e1;padding:10px;vertical-align:top}th{background:#f1f5f9;text-align:left}pre{white-space:pre-wrap;background:#f1f5f9;padding:16px;border-radius:6px}blockquote{margin-left:0;border-left:3px solid #cbd5e1;padding-left:20px}ul[data-type="taskList"]{list-style:none;padding-left:0}li[data-type="taskItem"]{display:flex;gap:8px}li[data-type="taskItem"]>div{flex:1}@media print{body{margin:0;max-width:none}@page{margin:18mm}a{color:inherit}}`

export function OcNoteEditor({
  value,
  onChange,
  disabled,
  locked,
  name,
  onValidityChange,
}: OcNoteEditorProps) {
  const t = useT()
  const [zoom, setZoom] = useState(100)
  const [outline, setOutline] = useState(false)
  const [search, setSearch] = useState(false)
  const [printError, setPrintError] = useState(false)
  const parsed = useMemo(() => {
    try {
      return { doc: parseOcNote(value), error: '' }
    } catch (e) {
      return {
        doc: undefined,
        error:
          e instanceof Error && e.message.includes('formatting') ? e.message : 'Invalid note file.',
      }
    }
  }, [value])
  const editor = useEditor({
    extensions: ocNoteExtensions,
    content: parsed.doc,
    editable: !disabled && !locked && !parsed.error,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        'aria-label': t('Note content'),
        role: 'textbox',
        'aria-multiline': 'true',
        spellcheck: 'true',
      },
    },
    onUpdate: ({ editor }) => onChange(JSON.stringify(editor.getJSON())),
  })
  useEffect(() => {
    editor?.setEditable(!disabled && !locked && !parsed.error, false)
    onValidityChange?.(!!editor && !parsed.error)
  }, [editor, disabled, locked, parsed.error, onValidityChange])
  useEditorState({ editor, selector: ({ transactionNumber }) => transactionNumber })
  const doc = editor?.state.doc
  const headings = useMemo(() => {
    const entries: NoteHeading[] = []
    doc?.descendants((node, position) => {
      if (node.type.name === 'heading')
        entries.push({ position, level: node.attrs.level, text: node.textContent })
    })
    return entries
  }, [doc])
  const text = useMemo(() => doc?.textBetween(0, doc.content.size, ' ') ?? '', [doc])
  const words = text.trim() ? text.trim().split(/\s+/).length : 0
  const print = () => {
    if (!editor) return
    const target = window.open('', '_blank', 'popup,width=1100,height=850')
    if (!target) return setPrintError(true)
    target.opener = null
    target.document.title = name ?? t('Note')
    const style = target.document.createElement('style')
    style.textContent = printStyles
    target.document.head.append(style)
    const article = target.document.createElement('article')
    // Tiptap generates this HTML through the same schema used by the on-screen editor.
    article.innerHTML = editor.getHTML()
    target.document.body.replaceChildren(article)
    void Promise.all(
      Array.from(article.querySelectorAll('img'), (image) =>
        image.decode?.().catch(() => undefined),
      ),
    ).then(() => {
      if (!target.closed) {
        target.focus()
        target.print()
      }
    })
  }
  return (
    <Box
      data-testid="ocnote-workspace"
      sx={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minHeight: 0,
        colorScheme: (theme) => theme.palette.mode,
      }}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && ['f', 'h', 'p'].includes(e.key.toLowerCase())) {
          e.preventDefault()
          if (e.key.toLowerCase() === 'p') print()
          else setSearch(true)
        }
      }}
    >
      <ViewBanner open={!!parsed.error} status="error">
        {t(parsed.error)}
      </ViewBanner>
      <ViewBanner open={printError} status="error" onClose={() => setPrintError(false)}>
        {t('Allow pop-ups to print this document.')}
      </ViewBanner>
      {!parsed.error && editor && (
        <>
          <OcNoteToolbar
            editor={editor}
            readOnly={disabled}
            locked={locked}
            zoom={zoom}
            onZoom={setZoom}
            outlineOpen={outline}
            onOutline={() => setOutline(!outline)}
            searchOpen={search}
            onSearch={() => setSearch(!search)}
            onPrint={print}
          />
          {search && (
            <OcNoteSearch
              editor={editor}
              readOnly={disabled || locked}
              onClose={() => setSearch(false)}
            />
          )}
          {!disabled && editor.isActive('codeBlock') && (
            <Stack
              direction="row"
              sx={{
                px: 2,
                py: 0.75,
                gap: 1.5,
                alignItems: 'center',
                borderBottom: 1,
                borderColor: 'divider',
              }}
            >
              <Typography variant="caption" color="text.secondary">
                {t('Code block')}
              </Typography>
              <TextField
                select
                size="small"
                label={t('Code language')}
                value={editor.getAttributes('codeBlock').language ?? ''}
                disabled={locked}
                sx={{ minWidth: 150 }}
                onChange={(e) =>
                  editor
                    .chain()
                    .focus()
                    .updateAttributes('codeBlock', { language: e.target.value || null })
                    .run()
                }
              >
                <MenuItem value="">{t('Automatic')}</MenuItem>
                {[
                  'plaintext',
                  'javascript',
                  'typescript',
                  'python',
                  'xml',
                  'css',
                  'json',
                  'bash',
                  'sql',
                  'go',
                  'rust',
                  'java',
                  'markdown',
                  'yaml',
                ].map((language) => (
                  <MenuItem key={language} value={language}>
                    {language}
                  </MenuItem>
                ))}
              </TextField>
            </Stack>
          )}
          <Box
            sx={{
              display: 'flex',
              flex: 1,
              minHeight: 0,
              position: 'relative',
              bgcolor: 'background.default',
            }}
          >
            {outline && (
              <OcNoteOutline
                editor={editor}
                headings={headings}
                onClose={() => setOutline(false)}
              />
            )}
            <Box
              data-testid="ocnote-scroll-area"
              sx={{
                flex: 1,
                minWidth: 0,
                overflow: 'auto',
                px: { xs: 0, sm: 3, lg: 5 },
                py: { xs: 0, sm: 3 },
                scrollbarGutter: 'stable',
              }}
            >
              <Box
                data-testid="ocnote-document"
                sx={{
                  mx: 'auto',
                  width: '100%',
                  maxWidth: 960,
                  minHeight: '100%',
                  bgcolor: 'background.paper',
                  border: { xs: 0, sm: 1 },
                  borderColor: { xs: 'transparent', sm: 'divider' },
                  borderRadius: { xs: 0, sm: 1 },
                  boxShadow: { xs: 'none', sm: '0 2px 8px #00000004' },
                  zoom: zoom / 100,
                  '& .ProseMirror': {
                    minHeight: 840,
                    outline: 'none',
                    px: { xs: 2.5, sm: 6, lg: 8 },
                    py: { xs: 3, sm: 5, lg: 6 },
                    color: 'text.primary',
                    fontFamily: 'Arial, sans-serif',
                    fontSize: 16,
                    lineHeight: 1.75,
                    overflowWrap: 'anywhere',
                    caretColor: 'primary.main',
                  },
                  '& .ProseMirror p': { my: '0.8em' },
                  '& .ProseMirror :is(h1,h2,h3,h4,h5,h6)': {
                    lineHeight: 1.3,
                    mt: '1.5em',
                    mb: '0.6em',
                    fontWeight: 700,
                    scrollMarginTop: 24,
                  },
                  '& .ProseMirror h1': { fontSize: '2.25em', letterSpacing: '-0.035em' },
                  '& .ProseMirror h2': { fontSize: '1.65em', letterSpacing: '-0.025em' },
                  '& .ProseMirror h3': { fontSize: '1.3em' },
                  '& .ProseMirror :is(h4,h5,h6)': { fontSize: '1.05em' },
                  '& .ProseMirror :is(ul,ol)': { pl: '1.7em' },
                  '& .ProseMirror li p': { my: '0.25em' },
                  '& .ProseMirror img': { maxWidth: '100%', height: 'auto', borderRadius: 1 },
                  '& .tableWrapper': { overflowX: 'auto', my: 3 },
                  '& .ProseMirror table': {
                    borderCollapse: 'collapse',
                    tableLayout: 'fixed',
                    width: '100%',
                    fontSize: '0.9em',
                    my: 3,
                  },
                  '& .ProseMirror :is(td,th)': {
                    border: 1,
                    borderColor: 'divider',
                    p: '0.75em 1em',
                    verticalAlign: 'top',
                    position: 'relative',
                    minWidth: 60,
                  },
                  '& .ProseMirror th': {
                    bgcolor: 'action.hover',
                    fontWeight: 600,
                    textAlign: 'left',
                  },
                  '& .ProseMirror .selectedCell::after': {
                    content: '""',
                    position: 'absolute',
                    inset: 0,
                    bgcolor: 'action.selected',
                    pointerEvents: 'none',
                  },
                  '& .ProseMirror pre': {
                    bgcolor: 'action.hover',
                    p: 2.5,
                    overflow: 'auto',
                    border: 1,
                    borderColor: 'divider',
                    borderRadius: 1.5,
                    fontSize: '0.85em',
                    lineHeight: 1.65,
                    tabSize: 2,
                  },
                  '& .ProseMirror code': {
                    fontFamily: 'Consolas, "Liberation Mono", monospace',
                    bgcolor: 'action.hover',
                    borderRadius: 0.5,
                    px: 0.4,
                    fontSize: '0.88em',
                  },
                  '& .ProseMirror pre code': { bgcolor: 'transparent', p: 0, fontSize: 'inherit' },
                  '& .hljs-keyword, & .hljs-selector-tag, & .hljs-built_in': {
                    color: 'secondary.main',
                  },
                  '& .hljs-string, & .hljs-attr': { color: 'success.main' },
                  '& .hljs-number, & .hljs-literal': { color: 'warning.main' },
                  '& .hljs-comment': { color: 'text.secondary', fontStyle: 'italic' },
                  '& .ProseMirror blockquote': {
                    borderLeft: 3,
                    borderColor: 'primary.main',
                    pl: 2.5,
                    ml: 0,
                    color: 'text.secondary',
                  },
                  '& .ProseMirror a': {
                    color: 'primary.main',
                    textDecoration: 'underline',
                    textUnderlineOffset: 3,
                  },
                  '& .ProseMirror hr': { border: 0, borderTop: 1, borderColor: 'divider', my: 4 },
                  '& ul[data-type="taskList"]': { listStyle: 'none', pl: 0 },
                  '& li[data-type="taskItem"]': {
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 1.5,
                  },
                  '& li[data-type="taskItem"] > div': { flex: 1 },
                  '& input[type="checkbox"]': {
                    accentColor: 'var(--mui-palette-primary-main)',
                    width: 15,
                    height: 15,
                  },
                }}
              >
                <EditorContent editor={editor} />
              </Box>
            </Box>
          </Box>
          <Stack
            direction="row"
            sx={{
              flexShrink: 0,
              alignItems: 'center',
              gap: 2.5,
              px: 2.5,
              py: 1,
              borderTop: 1,
              borderColor: 'divider',
              bgcolor: 'background.paper',
              color: 'text.secondary',
            }}
          >
            <Typography variant="caption">
              {words} {t('words')}
            </Typography>
            <Typography variant="caption">
              {text.length} {t('characters')}
            </Typography>
            <Typography variant="caption" sx={{ ml: 'auto' }}>
              {disabled ? t('Read only') : t('Editing')}
            </Typography>
            <Typography variant="caption">{zoom}%</Typography>
          </Stack>
        </>
      )}
    </Box>
  )
}
