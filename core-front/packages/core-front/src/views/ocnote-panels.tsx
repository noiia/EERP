'use client'
import { useEffect, useState } from 'react'
import type { Editor } from '@tiptap/core'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import IconButton from '@mui/material/IconButton'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import { faChevronDown, faChevronUp, faXmark } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from './icons'
import { useT } from '../i18n/translate'

export function OcNoteSearch({
  editor,
  readOnly,
  onClose,
}: {
  editor: Editor
  readOnly?: boolean
  onClose: () => void
}) {
  const t = useT()
  const [term, setTerm] = useState(editor.storage.findAndReplace.searchTerm)
  const [replacement, setReplacement] = useState('')
  const storage = editor.storage.findAndReplace
  useEffect(
    () => () => {
      if (!editor.isDestroyed) editor.commands.clearSearch()
    },
    [editor],
  )
  return (
    <Box
      role="search"
      aria-label={t('Find and replace')}
      sx={{
        px: { xs: 1.5, md: 3 },
        py: 1.5,
        borderBottom: 1,
        borderColor: 'divider',
        bgcolor: 'background.paper',
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onClose()
        }
        if (e.key === 'Enter') {
          e.preventDefault()
          if (e.shiftKey) editor.commands.goToPreviousResult()
          else editor.commands.goToNextResult()
        }
      }}
    >
      <Stack direction="row" sx={{ alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <TextField
          autoFocus
          size="small"
          label={t('Find in document')}
          value={term}
          sx={{ width: { xs: 180, sm: 260 } }}
          onChange={(e) => {
            setTerm(e.target.value)
            editor.commands.setSearchTerm(e.target.value)
          }}
        />
        <Typography
          variant="caption"
          color="text.secondary"
          role="status"
          aria-live="polite"
          sx={{ minWidth: 48 }}
        >
          {storage.results.length
            ? `${(storage.currentIndex ?? 0) + 1} / ${storage.results.length}`
            : t('No results')}
        </Typography>
        <Tooltip title={t('Previous result')}>
          <span>
            <IconButton
              aria-label={t('Previous result')}
              size="small"
              disabled={!storage.results.length}
              onClick={() => editor.commands.goToPreviousResult()}
            >
              <FontAwesomeIcon icon={faChevronUp} />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title={t('Next result')}>
          <span>
            <IconButton
              aria-label={t('Next result')}
              size="small"
              disabled={!storage.results.length}
              onClick={() => editor.commands.goToNextResult()}
            >
              <FontAwesomeIcon icon={faChevronDown} />
            </IconButton>
          </span>
        </Tooltip>
        <Button
          size="small"
          aria-pressed={storage.caseSensitive}
          variant={storage.caseSensitive ? 'outlined' : 'text'}
          onClick={() => editor.commands.setCaseSensitive(!storage.caseSensitive)}
        >
          {t('Match case')}
        </Button>
        <Button
          size="small"
          aria-pressed={storage.wholeWord}
          variant={storage.wholeWord ? 'outlined' : 'text'}
          onClick={() => editor.commands.setWholeWord(!storage.wholeWord)}
        >
          {t('Whole words')}
        </Button>
        <IconButton
          aria-label={t('Close search')}
          size="small"
          sx={{ ml: 'auto' }}
          onClick={onClose}
        >
          <FontAwesomeIcon icon={faXmark} />
        </IconButton>
      </Stack>
      {!readOnly && (
        <Stack direction="row" sx={{ alignItems: 'center', gap: 1, mt: 1, flexWrap: 'wrap' }}>
          <TextField
            size="small"
            label={t('Replace with')}
            value={replacement}
            sx={{ width: { xs: 180, sm: 260 } }}
            onChange={(e) => {
              setReplacement(e.target.value)
              editor.commands.setReplaceTerm(e.target.value)
            }}
          />
          <Button
            size="small"
            disabled={!storage.results.length}
            onClick={() => editor.commands.replace()}
          >
            {t('Replace')}
          </Button>
          <Button
            size="small"
            disabled={!storage.results.length}
            onClick={() => editor.commands.replaceAll()}
          >
            {t('Replace all')}
          </Button>
        </Stack>
      )}
    </Box>
  )
}

export interface NoteHeading {
  position: number
  level: number
  text: string
}

export function OcNoteOutline({
  editor,
  headings,
  onClose,
}: {
  editor: Editor
  headings: NoteHeading[]
  onClose: () => void
}) {
  const t = useT()
  const current = [...headings]
    .reverse()
    .find((heading) => heading.position <= editor.state.selection.from)
  return (
    <Box
      component="aside"
      aria-label={t('Document outline')}
      sx={{
        width: { xs: 230, md: 250 },
        flexShrink: 0,
        borderRight: 1,
        borderColor: 'divider',
        bgcolor: 'background.paper',
        position: { xs: 'absolute', md: 'relative' },
        inset: { xs: '0 auto 0 0', md: 'auto' },
        zIndex: 2,
        boxShadow: { xs: 4, md: 'none' },
        overflowY: 'auto',
      }}
    >
      <Stack
        direction="row"
        sx={{ alignItems: 'center', justifyContent: 'space-between', px: 2.5, py: 1.5 }}
      >
        <Typography variant="overline" sx={{ fontSize: 11, fontWeight: 700, letterSpacing: 1.2 }}>
          {t('Outline')}
        </Typography>
        <IconButton aria-label={t('Close outline')} size="small" onClick={onClose}>
          <FontAwesomeIcon icon={faXmark} size="xs" />
        </IconButton>
      </Stack>
      {headings.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ px: 2.5 }}>
          {t('Add headings to navigate your document.')}
        </Typography>
      ) : (
        <Box component="nav" aria-label={t('Headings')} sx={{ px: 1.25, pb: 3 }}>
          {headings.map((heading) => (
            <Button
              key={heading.position}
              fullWidth
              title={heading.text}
              aria-current={current?.position === heading.position ? 'location' : undefined}
              onClick={() => {
                const node = editor.view.nodeDOM(heading.position)
                if (node instanceof HTMLElement)
                  node.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
                editor.commands.setTextSelection(heading.position + 1)
              }}
              sx={{
                display: 'block',
                textAlign: 'left',
                pl: 1.5 + (heading.level - 1) * 1.5,
                pr: 1,
                py: 0.85,
                my: 0.25,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontSize: 12.5,
                fontWeight: heading.level <= 2 ? 600 : 400,
                color: current?.position === heading.position ? 'primary.main' : 'text.secondary',
                bgcolor: current?.position === heading.position ? 'action.selected' : undefined,
              }}
            >
              {heading.text || t('Untitled heading')}
            </Button>
          ))}
        </Box>
      )}
    </Box>
  )
}
