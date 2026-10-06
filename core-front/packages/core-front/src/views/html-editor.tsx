'use client'
import { useEffect } from 'react'
import Box from '@mui/material/Box'
import Chip from '@mui/material/Chip'
import IconButton from '@mui/material/IconButton'
import Stack from '@mui/material/Stack'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import { EditorContent, useEditor, useEditorState } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useT } from '../i18n/translate'
import { byPrefixAndName, FontAwesomeIcon } from './icons'

// A small WYSIWYG for rich text stored as HTML (the `text/html` widget, and
// Settings → Email templates). Output is NOT trusted: whoever stores it must
// sanitize it server-side (internal/mail sanitizes template bodies on save).
// Headings off: the allowlist keeps formatting, lists and links.

export interface HtmlEditorProps {
  value: string
  onChange: (html: string) => void
  disabled?: boolean
  label?: string
  /** Snippets offered as chips that insert at the cursor, e.g. "{{name}}". */
  insertions?: string[]
}

export function HtmlEditor({ value, onChange, disabled, label, insertions }: HtmlEditorProps) {
  const t = useT()
  const editor = useEditor({
    extensions: [StarterKit.configure({ heading: false, codeBlock: false, code: false, link: { openOnClick: false } })],
    content: value,
    editable: !disabled,
    immediatelyRender: false, // server-rendered pages: create the editor on the client only
    onUpdate: ({ editor }) => onChange(editor.getHTML()),
  })
  // A new value from outside (another record or template picked) replaces the content;
  // the editor's own edits come back equal and are left alone.
  useEffect(() => {
    if (editor && value !== editor.getHTML()) editor.commands.setContent(value, { emitUpdate: false })
  }, [editor, value])
  useEffect(() => {
    editor?.setEditable(!disabled)
  }, [editor, disabled])
  const active = useEditorState({
    editor,
    selector: ({ editor }) => ({
      bold: editor?.isActive('bold') ?? false,
      italic: editor?.isActive('italic') ?? false,
      underline: editor?.isActive('underline') ?? false,
      bullets: editor?.isActive('bulletList') ?? false,
      numbers: editor?.isActive('orderedList') ?? false,
      link: editor?.isActive('link') ?? false,
    }),
  })

  const tool = (name: string, icon: string, on: boolean | undefined, run: () => void) => (
    <Tooltip key={name} title={t(name)}>
      <span>
        <IconButton size="small" aria-label={t(name)} aria-pressed={on} disabled={disabled || !editor}
          color={on ? 'primary' : 'default'} onMouseDown={(e) => e.preventDefault()} onClick={run}>
          <FontAwesomeIcon icon={byPrefixAndName.fas[icon]} size="sm" />
        </IconButton>
      </span>
    </Tooltip>
  )
  const chain = () => editor!.chain().focus()
  const link = () => {
    if (active?.link) return void chain().unsetLink().run()
    const url = window.prompt(t('Link address (https://…, mailto:… or {{variable}})'))
    if (url) chain().extendMarkRange('link').setLink({ href: url }).run()
  }

  return (
    <Box>
      {label && <Typography variant="caption" color="text.secondary">{label}</Typography>}
      <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, '&:focus-within': { borderColor: 'primary.main' } }}>
        <Stack direction="row" spacing={0.5} sx={{ p: 0.5, borderBottom: 1, borderColor: 'divider', flexWrap: 'wrap' }}>
          {tool('Bold', 'bold', active?.bold, () => chain().toggleBold().run())}
          {tool('Italic', 'italic', active?.italic, () => chain().toggleItalic().run())}
          {tool('Underline', 'underline', active?.underline, () => chain().toggleUnderline().run())}
          {tool('Bulleted list', 'list-ul', active?.bullets, () => chain().toggleBulletList().run())}
          {tool('Numbered list', 'list-ol', active?.numbers, () => chain().toggleOrderedList().run())}
          {tool(active?.link ? 'Remove link' : 'Link', active?.link ? 'link-slash' : 'link', active?.link, link)}
        </Stack>
        <Box sx={{ px: 1.5, '& .ProseMirror': { minHeight: 160, outline: 'none' }, '& .ProseMirror p': { my: 1 } }}>
          <EditorContent editor={editor} />
        </Box>
      </Box>
      {insertions && insertions.length > 0 && (
        <Stack direction="row" spacing={0.5} sx={{ mt: 1, flexWrap: 'wrap', gap: 0.5 }}>
          {insertions.map((s) => (
            <Chip key={s} label={s} size="small" variant="outlined" disabled={disabled || !editor}
              onMouseDown={(e) => e.preventDefault()} onClick={() => chain().insertContent(s).run()} />
          ))}
        </Stack>
      )}
    </Box>
  )
}
