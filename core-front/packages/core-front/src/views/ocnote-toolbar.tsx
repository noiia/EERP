'use client'
import { useRef, useState, type ReactNode } from 'react'
import type { Editor } from '@tiptap/core'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import ButtonBase from '@mui/material/ButtonBase'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Divider from '@mui/material/Divider'
import IconButton from '@mui/material/IconButton'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import {
  faAlignCenter,
  faAlignJustify,
  faAlignLeft,
  faAlignRight,
  faArrowRotateLeft,
  faArrowRotateRight,
  faBold,
  faChevronDown,
  faEraser,
  faFont,
  faHighlighter,
  faImage,
  faItalic,
  faLink,
  faListCheck,
  faListOl,
  faListUl,
  faMagnifyingGlass,
  faMinus,
  faPalette,
  faPrint,
  faStrikethrough,
  faSubscript,
  faSuperscript,
  faTable,
  faUnderline,
  faList,
  faArrowsUpDown,
} from '@fortawesome/free-solid-svg-icons'
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import { FontAwesomeIcon } from './icons'
import { ViewBanner } from './banner'
import { useT } from '../i18n/translate'

// Keep editor-only icons in this lazy chunk. An unregistered string lookup made
// several of the original toolbar's buttons empty.
function Tool({
  label,
  icon,
  active,
  disabled,
  onClick,
}: {
  label: string
  icon: IconDefinition
  active?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  const t = useT()
  return (
    <Tooltip title={t(label)}>
      <span>
        <IconButton
          aria-label={t(label)}
          aria-pressed={active}
          size="small"
          disabled={disabled}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onClick}
          sx={{
            width: 34,
            height: 34,
            borderRadius: 1,
            color: active ? 'primary.main' : 'text.secondary',
            bgcolor: active ? 'action.selected' : undefined,
          }}
        >
          <FontAwesomeIcon icon={icon} style={{ width: 15, height: 15 }} />
        </IconButton>
      </span>
    </Tooltip>
  )
}

function ToolMenu({
  label,
  icon,
  text,
  disabled,
  children,
}: {
  label: string
  icon?: IconDefinition
  text?: string
  disabled?: boolean
  children: (close: () => void) => ReactNode
}) {
  const t = useT()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  return (
    <>
      <Tooltip title={t(label)}>
        <span>
          <Button
            aria-label={t(label)}
            aria-haspopup="menu"
            aria-expanded={!!anchor}
            size="small"
            disabled={disabled}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => setAnchor(e.currentTarget)}
            sx={{
              minWidth: 38,
              height: 34,
              px: 1,
              gap: 0.8,
              color: 'text.secondary',
              fontWeight: 500,
              whiteSpace: 'nowrap',
              bgcolor: anchor ? 'action.selected' : undefined,
            }}
          >
            {icon && <FontAwesomeIcon icon={icon} style={{ width: 15, height: 15 }} />}
            {text && <span>{text}</span>}
            <FontAwesomeIcon icon={faChevronDown} style={{ width: 8, height: 8 }} />
          </Button>
        </span>
      </Tooltip>
      <Menu
        anchorEl={anchor}
        open={!!anchor}
        disableRestoreFocus
        onClose={() => setAnchor(null)}
        slotProps={{
          paper: {
            sx: { minWidth: 180, mt: 0.5, border: 1, borderColor: 'divider', borderRadius: 2 },
          },
        }}
      >
        {children(() => setAnchor(null))}
      </Menu>
    </>
  )
}

const colors = [
  '#111827',
  '#64748b',
  '#ffffff',
  '#dc2626',
  '#ea580c',
  '#d97706',
  '#16a34a',
  '#0d9488',
  '#0284c7',
  '#2563eb',
  '#4f46e5',
  '#9333ea',
  '#db2777',
  '#fee2e2',
  '#ffedd5',
  '#fef3c7',
  '#dcfce7',
  '#ccfbf1',
  '#e0f2fe',
  '#dbeafe',
  '#e0e7ff',
  '#f3e8ff',
  '#fce7f3',
  '#f1f5f9',
]

function ColorMenu({
  editor,
  background,
  disabled,
}: {
  editor: Editor
  background?: boolean
  disabled?: boolean
}) {
  const t = useT()
  const label = background ? 'Background color' : 'Text color'
  const current = editor.getAttributes('textStyle')[background ? 'backgroundColor' : 'color']
  const apply = (color: string) => {
    const chain = editor.chain().focus()
    if (background) chain.setBackgroundColor(color).run()
    else chain.setColor(color).run()
  }
  return (
    <ToolMenu label={label} icon={background ? faHighlighter : faFont} disabled={disabled}>
      {(close) => (
        <Box sx={{ px: 1.5, py: 0.5, width: 216 }}>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
            {t(label)}
          </Typography>
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 0.75 }}>
            {colors.map((color) => (
              <ButtonBase
                key={color}
                aria-label={`${t(label)} ${color}`}
                aria-pressed={current === color}
                onClick={() => {
                  apply(color)
                  close()
                }}
                sx={{
                  height: 25,
                  borderRadius: 0.75,
                  bgcolor: color,
                  border: 1,
                  borderColor: current === color ? 'primary.main' : '#00000020',
                  outline: current === color ? '2px solid' : undefined,
                  outlineColor: 'primary.main',
                  outlineOffset: 2,
                }}
              />
            ))}
          </Box>
          <Button
            component="label"
            size="small"
            fullWidth
            startIcon={<FontAwesomeIcon icon={faPalette} />}
            sx={{ mt: 1 }}
          >
            {t('Custom color')}
            <input
              type="color"
              aria-label={t('Custom color')}
              value={/^#[\da-f]{6}$/i.test(current ?? '') ? current : '#4f46e5'}
              onChange={(e) => {
                apply(e.target.value)
                close()
              }}
              style={{ position: 'absolute', opacity: 0, width: 1, height: 1 }}
            />
          </Button>
          <Button
            size="small"
            fullWidth
            color="inherit"
            onClick={() => {
              const chain = editor.chain().focus()
              if (background) chain.unsetBackgroundColor().run()
              else chain.unsetColor().run()
              close()
            }}
          >
            {t('Reset color')}
          </Button>
        </Box>
      )}
    </ToolMenu>
  )
}

function TableMenu({ editor, disabled }: { editor: Editor; disabled?: boolean }) {
  const t = useT()
  const [size, setSize] = useState({ rows: 3, cols: 3 })
  const commands = [
    ['Add row above', () => editor.chain().focus().addRowBefore().run()],
    ['Add row below', () => editor.chain().focus().addRowAfter().run()],
    ['Add column before', () => editor.chain().focus().addColumnBefore().run()],
    ['Add column after', () => editor.chain().focus().addColumnAfter().run()],
    ['Toggle header row', () => editor.chain().focus().toggleHeaderRow().run()],
    ['Merge cells', () => editor.chain().focus().mergeCells().run()],
    ['Split cell', () => editor.chain().focus().splitCell().run()],
    ['Delete row', () => editor.chain().focus().deleteRow().run()],
    ['Delete column', () => editor.chain().focus().deleteColumn().run()],
    ['Delete table', () => editor.chain().focus().deleteTable().run()],
  ] as const
  return (
    <ToolMenu label="Insert table" icon={faTable} disabled={disabled}>
      {(close) => (
        <Box>
          <Box sx={{ p: 1.5 }}>
            <Typography variant="caption" color="text.secondary">
              {t('Insert table')}
            </Typography>
            <Box
              role="group"
              aria-label={t('Table size')}
              sx={{ display: 'grid', gridTemplateColumns: 'repeat(6, 22px)', gap: 0.5, my: 1 }}
            >
              {Array.from({ length: 36 }, (_, i) => ({
                rows: Math.floor(i / 6) + 1,
                cols: (i % 6) + 1,
              })).map(({ rows, cols }) => (
                <ButtonBase
                  key={`${rows}-${cols}`}
                  aria-label={`${cols} × ${rows}`}
                  onMouseEnter={() => setSize({ rows, cols })}
                  onFocus={() => setSize({ rows, cols })}
                  onClick={() => {
                    editor.chain().focus().insertTable({ rows, cols, withHeaderRow: true }).run()
                    close()
                  }}
                  sx={{
                    height: 22,
                    borderRadius: 0.5,
                    border: 1,
                    borderColor:
                      rows <= size.rows && cols <= size.cols ? 'primary.main' : 'divider',
                    bgcolor:
                      rows <= size.rows && cols <= size.cols
                        ? 'action.selected'
                        : 'background.paper',
                  }}
                />
              ))}
            </Box>
            <Typography variant="caption" color="text.secondary">
              {size.cols} × {size.rows}
            </Typography>
          </Box>
          {editor.isActive('table') && (
            <>
              <Divider />
              {commands.map(([label, run]) => (
                <MenuItem
                  key={label}
                  disabled={
                    label === 'Merge cells'
                      ? !editor.can().mergeCells()
                      : label === 'Split cell'
                        ? !editor.can().splitCell()
                        : false
                  }
                  onClick={() => {
                    run()
                    close()
                  }}
                >
                  {t(label)}
                </MenuItem>
              ))}
            </>
          )}
        </Box>
      )}
    </ToolMenu>
  )
}

export interface OcNoteToolbarProps {
  editor: Editor
  readOnly?: boolean
  locked?: boolean
  zoom: number
  onZoom: (zoom: number) => void
  outlineOpen: boolean
  onOutline: () => void
  searchOpen: boolean
  onSearch: () => void
  onPrint: () => void
}

export function OcNoteToolbar({
  editor,
  readOnly,
  locked,
  zoom,
  onZoom,
  outlineOpen,
  onOutline,
  searchOpen,
  onSearch,
  onPrint,
}: OcNoteToolbarProps) {
  const t = useT()
  const [insert, setInsert] = useState<'link' | 'image' | null>(null)
  const [address, setAddress] = useState('')
  const [linkText, setLinkText] = useState('')
  const [invalid, setInvalid] = useState(false)
  const [error, setError] = useState('')
  const upload = useRef<HTMLInputElement>(null)
  const chain = () => editor.chain().focus()
  const group = (children: ReactNode) => (
    <Stack
      direction="row"
      sx={{
        alignItems: 'center',
        gap: 0.25,
        px: 0.75,
        borderRight: 1,
        borderColor: 'divider',
        flexShrink: 0,
      }}
    >
      {children}
    </Stack>
  )
  const item =
    (label: string, run: () => void, selected = false) =>
    (close: () => void) => (
      <MenuItem
        key={label}
        selected={selected}
        onClick={() => {
          run()
          close()
        }}
      >
        {t(label)}
      </MenuItem>
    )
  const openInsert = (kind: 'link' | 'image') => {
    setAddress(kind === 'link' ? (editor.getAttributes('link').href ?? '') : '')
    setInvalid(false)
    setLinkText('')
    setInsert(kind)
  }
  const addAddress = () => {
    let url = address.trim()
    if (!url || /\s/.test(url)) return setInvalid(true)
    if (!/^[a-z][\w+.-]*:/i.test(url) && !url.startsWith('#') && !url.startsWith('/'))
      url = `https://${url}`
    if (
      !(insert === 'image'
        ? /^https?:\/\//i.test(url)
        : /^(https?:\/\/|mailto:|#|\/(?!\/))/i.test(url))
    )
      return setInvalid(true)
    try {
      const parsed = new URL(url, window.location.href)
      if (['http:', 'https:'].includes(parsed.protocol) && !parsed.hostname) return setInvalid(true)
      if (parsed.protocol === 'mailto:' && !parsed.pathname) return setInvalid(true)
    } catch {
      return setInvalid(true)
    }
    if (insert === 'image') chain().setImage({ src: url, alt: '' }).run()
    else if (editor.state.selection.empty && !editor.isActive('link'))
      chain()
        .insertContent({
          type: 'text',
          text: linkText.trim() || url,
          marks: [{ type: 'link', attrs: { href: url } }],
        })
        .run()
    else chain().extendMarkRange('link').setLink({ href: url }).run()
    setInsert(null)
  }
  return (
    <>
      <ViewBanner open={!!error} status="error" onClose={() => setError('')}>
        {t(error)}
      </ViewBanner>
      <Box
        role="toolbar"
        aria-label={t('Document tools')}
        sx={{
          display: 'flex',
          alignItems: 'center',
          flexShrink: 0,
          overflow: 'hidden',
          px: 1,
          py: 0.75,
          minHeight: 52,
          borderBottom: 1,
          borderColor: 'divider',
          bgcolor: 'background.paper',
        }}
      >
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            flex: 1,
            minWidth: 0,
            overflowX: 'auto',
            scrollbarWidth: 'thin',
          }}
        >
          {!readOnly &&
            group(
              <>
                <Tool
                  label="Undo"
                  icon={faArrowRotateLeft}
                  disabled={locked || !editor.can().undo()}
                  onClick={() => chain().undo().run()}
                />
                <Tool
                  label="Redo"
                  icon={faArrowRotateRight}
                  disabled={locked || !editor.can().redo()}
                  onClick={() => chain().redo().run()}
                />
              </>,
            )}
          {group(
            <ToolMenu label="Zoom" text={`${zoom}%`}>
              {(close) =>
                [75, 90, 100, 110, 125, 150, 175, 200].map((n) => (
                  <MenuItem
                    key={n}
                    selected={zoom === n}
                    onClick={() => {
                      onZoom(n)
                      close()
                    }}
                  >
                    {n}%
                  </MenuItem>
                ))
              }
            </ToolMenu>,
          )}
          {!readOnly && (
            <>
              {group(
                <>
                  <ToolMenu
                    label="Text style"
                    text={
                      editor.isActive('heading')
                        ? `${t('Heading')} ${editor.getAttributes('heading').level}`
                        : t('Normal text')
                    }
                    disabled={locked}
                  >
                    {(close) => (
                      <>
                        {item(
                          'Normal text',
                          () => chain().setParagraph().run(),
                          editor.isActive('paragraph'),
                        )(close)}
                        {([1, 2, 3, 4, 5, 6] as const).map((level) => (
                          <MenuItem
                            key={level}
                            selected={editor.isActive('heading', { level })}
                            onClick={() => {
                              chain().setHeading({ level }).run()
                              close()
                            }}
                            sx={{ fontSize: 21 - level, fontWeight: 600 }}
                          >
                            {t('Heading')} {level}
                          </MenuItem>
                        ))}
                        <Divider />
                        {item(
                          'Blockquote',
                          () => chain().toggleBlockquote().run(),
                          editor.isActive('blockquote'),
                        )(close)}
                        {item(
                          'Code block',
                          () => chain().toggleCodeBlock().run(),
                          editor.isActive('codeBlock'),
                        )(close)}
                      </>
                    )}
                  </ToolMenu>
                  <ToolMenu
                    label="Font family"
                    text={
                      (editor.getAttributes('textStyle').fontFamily ?? t('Default')).split(',')[0]
                    }
                    disabled={locked}
                  >
                    {(close) =>
                      ['Default', 'Arial', 'Georgia', 'Verdana', 'monospace'].map((font) => (
                        <MenuItem
                          key={font}
                          sx={{ fontFamily: font === 'Default' ? undefined : font }}
                          onClick={() => {
                            if (font === 'Default') chain().unsetFontFamily().run()
                            else chain().setFontFamily(font).run()
                            close()
                          }}
                        >
                          {font === 'Default' ? t('Default') : font}
                        </MenuItem>
                      ))
                    }
                  </ToolMenu>
                  <ToolMenu
                    label="Font size"
                    text={(editor.getAttributes('textStyle').fontSize ?? '16px').replace('px', '')}
                    disabled={locked}
                  >
                    {(close) =>
                      [10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64].map((n) => (
                        <MenuItem
                          key={n}
                          onClick={() => {
                            chain().setFontSize(`${n}px`).run()
                            close()
                          }}
                        >
                          {n}
                        </MenuItem>
                      ))
                    }
                  </ToolMenu>
                </>,
              )}
              {group(
                <>
                  <ColorMenu editor={editor} disabled={locked} />
                  <ColorMenu editor={editor} background disabled={locked} />
                </>,
              )}
              {group(
                <>
                  <Tool
                    label="Bold"
                    icon={faBold}
                    active={editor.isActive('bold')}
                    disabled={locked}
                    onClick={() => chain().toggleBold().run()}
                  />
                  <Tool
                    label="Italic"
                    icon={faItalic}
                    active={editor.isActive('italic')}
                    disabled={locked}
                    onClick={() => chain().toggleItalic().run()}
                  />
                  <Tool
                    label="Underline"
                    icon={faUnderline}
                    active={editor.isActive('underline')}
                    disabled={locked}
                    onClick={() => chain().toggleUnderline().run()}
                  />
                  <Tool
                    label="Strikethrough"
                    icon={faStrikethrough}
                    active={editor.isActive('strike')}
                    disabled={locked}
                    onClick={() => chain().toggleStrike().run()}
                  />
                  <Tool
                    label="Subscript"
                    icon={faSubscript}
                    active={editor.isActive('subscript')}
                    disabled={locked}
                    onClick={() => chain().toggleSubscript().run()}
                  />
                  <Tool
                    label="Superscript"
                    icon={faSuperscript}
                    active={editor.isActive('superscript')}
                    disabled={locked}
                    onClick={() => chain().toggleSuperscript().run()}
                  />
                </>,
              )}
              {group(
                <>
                  <Tool
                    label="Bulleted list"
                    icon={faListUl}
                    active={editor.isActive('bulletList')}
                    disabled={locked}
                    onClick={() => chain().toggleBulletList().run()}
                  />
                  <Tool
                    label="Numbered list"
                    icon={faListOl}
                    active={editor.isActive('orderedList')}
                    disabled={locked}
                    onClick={() => chain().toggleOrderedList().run()}
                  />
                  <Tool
                    label="Task list"
                    icon={faListCheck}
                    active={editor.isActive('taskList')}
                    disabled={locked}
                    onClick={() => chain().toggleTaskList().run()}
                  />
                </>,
              )}
              {group(
                <>
                  <ToolMenu
                    label="Alignment"
                    icon={
                      editor.isActive({ textAlign: 'center' })
                        ? faAlignCenter
                        : editor.isActive({ textAlign: 'right' })
                          ? faAlignRight
                          : editor.isActive({ textAlign: 'justify' })
                            ? faAlignJustify
                            : faAlignLeft
                    }
                    disabled={locked}
                  >
                    {(close) =>
                      (
                        [
                          ['Align left', 'left'],
                          ['Align center', 'center'],
                          ['Align right', 'right'],
                          ['Justify', 'justify'],
                        ] as const
                      ).map(([label, align]) =>
                        item(
                          label,
                          () => chain().setTextAlign(align).run(),
                          editor.isActive({ textAlign: align }),
                        )(close),
                      )
                    }
                  </ToolMenu>
                  <ToolMenu label="Line spacing" icon={faArrowsUpDown} disabled={locked}>
                    {(close) =>
                      ['1', '1.15', '1.5', '2', '2.5', '3'].map((n) => (
                        <MenuItem
                          key={n}
                          onClick={() => {
                            chain().setLineHeight(n).run()
                            close()
                          }}
                        >
                          {n}
                        </MenuItem>
                      ))
                    }
                  </ToolMenu>
                </>,
              )}
              {group(
                <>
                  <Tool
                    label="Link"
                    icon={faLink}
                    active={editor.isActive('link')}
                    disabled={locked}
                    onClick={() => openInsert('link')}
                  />
                  <ToolMenu label="Insert image" icon={faImage} disabled={locked}>
                    {(close) => (
                      <>
                        <MenuItem
                          onClick={() => {
                            upload.current?.click()
                            close()
                          }}
                        >
                          {t('Upload image')}
                        </MenuItem>
                        <MenuItem
                          onClick={() => {
                            close()
                            openInsert('image')
                          }}
                        >
                          {t('Image from URL')}
                        </MenuItem>
                        {editor.isActive('image') && (
                          <MenuItem
                            onClick={() => {
                              chain().deleteSelection().run()
                              close()
                            }}
                          >
                            {t('Remove image')}
                          </MenuItem>
                        )}
                      </>
                    )}
                  </ToolMenu>
                  <TableMenu editor={editor} disabled={locked} />
                  <Tool
                    label="Horizontal line"
                    icon={faMinus}
                    disabled={locked}
                    onClick={() => chain().setHorizontalRule().run()}
                  />
                  <Tool
                    label="Clear formatting"
                    icon={faEraser}
                    disabled={locked}
                    onClick={() => chain().unsetAllMarks().clearNodes().run()}
                  />
                </>,
              )}
            </>
          )}
        </Box>
        <Stack
          direction="row"
          sx={{ pl: 1, gap: 0.25, flexShrink: 0, borderLeft: 1, borderColor: 'divider' }}
        >
          <Tool
            label="Find and replace"
            icon={faMagnifyingGlass}
            active={searchOpen}
            onClick={onSearch}
          />
          <Tool label="Document outline" icon={faList} active={outlineOpen} onClick={onOutline} />
          <Tool label="Print" icon={faPrint} onClick={onPrint} />
        </Stack>
      </Box>
      <input
        ref={upload}
        hidden
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/avif"
        aria-label={t('Upload image')}
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (!file) return
          if (file.size > 5 * 1024 * 1024) return setError('Choose an image smaller than 5 MB.')
          const reader = new FileReader()
          reader.onload = () => {
            if (!editor.isDestroyed && typeof reader.result === 'string')
              editor.chain().focus().setImage({ src: reader.result, alt: file.name }).run()
          }
          reader.onerror = () => setError('The image could not be loaded.')
          reader.readAsDataURL(file)
        }}
      />
      <Dialog
        open={insert !== null}
        disableRestoreFocus
        onClose={() => setInsert(null)}
        fullWidth
        maxWidth="xs"
        aria-labelledby="note-insert-title"
      >
        <DialogTitle id="note-insert-title">
          {t(insert === 'image' ? 'Insert image' : 'Link')}
        </DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            size="small"
            sx={{ mt: 1 }}
            label={t(insert === 'image' ? 'Image address' : 'Link address')}
            value={address}
            onChange={(e) => {
              setAddress(e.target.value)
              setInvalid(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addAddress()
            }}
            error={invalid}
            helperText={invalid ? t('Enter a valid address.') : 'https://…'}
          />
          {insert === 'link' && editor.state.selection.empty && !editor.isActive('link') && (
            <TextField
              fullWidth
              size="small"
              sx={{ mt: 2 }}
              label={t('Link text')}
              value={linkText}
              onChange={(e) => setLinkText(e.target.value)}
            />
          )}
        </DialogContent>
        <DialogActions>
          {insert === 'link' && editor.isActive('link') && (
            <Button
              color="error"
              onClick={() => {
                chain().extendMarkRange('link').unsetLink().run()
                setInsert(null)
              }}
            >
              {t('Remove link')}
            </Button>
          )}
          <Button onClick={() => setInsert(null)}>{t('Cancel')}</Button>
          <Button variant="contained" onClick={addAddress}>
            {t('Insert')}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  )
}
