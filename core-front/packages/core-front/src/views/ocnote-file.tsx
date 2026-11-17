'use client'
import { useEffect, useId, useState, type ReactNode } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Link from '@mui/material/Link'
import IconButton from '@mui/material/IconButton'
import Stack from '@mui/material/Stack'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import { alpha } from '@mui/material/styles'
import { parseError } from '../api/errors'
import { useT } from '../i18n/translate'
import { BannerScope, BannerSlot, ViewBanner } from './banner'
import { OcNoteEditor } from './lazy-widgets'
import { byPrefixAndName, FontAwesomeIcon } from './icons'

export const isOcNote = (filename: string) => filename.toLowerCase().endsWith('.ocnote')

export interface OcNoteDialogProps {
  name: string
  /** Omit for a new note. Reads stay on the host's authenticated BFF. */
  url?: string
  onSave?: (content: string, version: string) => Promise<{ version: string } | void>
  onClose: () => void
}

export function OcNoteDialog({ name, url, onSave, onClose }: OcNoteDialogProps) {
  const t = useT()
  const titleId = useId()
  const [content, setContent] = useState<string | null>(url ? null : '')
  const [version, setVersion] = useState('')
  const [valid, setValid] = useState(false)
  const [dirty, setDirty] = useState(!url)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [discard, setDiscard] = useState(false)
  useEffect(() => {
    if (!url) return
    const controller = new AbortController()
    void (async () => {
      try {
        const res = await fetch(url, { signal: controller.signal, cache: 'no-store' })
        if (!res.ok) throw await parseError(res)
        const text = await res.text()
        if (!controller.signal.aborted) {
          setVersion(res.headers.get('etag') ?? '')
          setContent(text)
        }
      } catch (e) {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => controller.abort()
  }, [url])
  useEffect(() => {
    if (!dirty || !onSave) return
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [dirty, onSave])
  const close = () => {
    if (busy) return
    if (onSave && dirty) setDiscard(true)
    else onClose()
  }
  const save = async () => {
    if (!onSave || content === null || !valid) return
    setBusy(true)
    setError('')
    try {
      const value =
        content.trim() || JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] })
      const saved = await onSave(value, version)
      if (saved?.version) setVersion(saved.version)
      setDirty(false)
      if (!url) onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onClose={close}
      fullScreen
      aria-labelledby={titleId}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault()
          if (!busy && dirty && valid) void save()
        }
      }}
      sx={{
        '& .MuiDialog-paper': {
          m: { xs: 0, md: 1 },
          width: { xs: '100%', md: 'calc(100% - 16px)' },
          height: { xs: '100%', md: 'calc(100% - 16px)' },
          borderRadius: { xs: 0, md: 2 },
          overflow: 'hidden',
          border: 1,
          borderColor: 'divider',
        },
      }}
    >
      <BannerScope>
        <Stack
          direction="row"
          sx={{
            alignItems: 'center',
            gap: { xs: 1.25, sm: 2 },
            px: { xs: 1.5, sm: 3 },
            py: 1.5,
            minHeight: 72,
            flexShrink: 0,
            borderBottom: 1,
            borderColor: 'divider',
            bgcolor: 'background.paper',
          }}
        >
          <Box
            sx={(theme) => ({
              display: 'grid',
              placeItems: 'center',
              width: 38,
              height: 42,
              flexShrink: 0,
              borderRadius: 1.5,
              color: 'primary.main',
              bgcolor: alpha(theme.palette.primary.main, 0.09),
            })}
          >
            <FontAwesomeIcon
              icon={byPrefixAndName.fas['file-lines']}
              style={{ width: 18, height: 22 }}
            />
          </Box>
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography
              id={titleId}
              component="h2"
              variant="subtitle1"
              title={name}
              noWrap
              sx={{ fontWeight: 650, lineHeight: 1.45 }}
            >
              {name}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {onSave ? t('Note') : t('Read only')}
            </Typography>
          </Box>
          {onSave && (
            <Stack
              direction="row"
              role="status"
              aria-live="polite"
              sx={{
                alignItems: 'center',
                gap: 0.75,
                color: 'text.secondary',
                display: { xs: 'none', sm: 'flex' },
                mr: 1,
              }}
            >
              <Box
                sx={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  bgcolor: dirty ? 'warning.main' : 'success.main',
                }}
              />
              <Typography variant="caption">
                {busy ? t('Saving…') : dirty ? t('Unsaved changes') : t('All changes saved')}
              </Typography>
            </Stack>
          )}
          {url && (
            <Tooltip title={t('Download')}>
              <IconButton
                component="a"
                href={url}
                download={name}
                aria-label={t('Download')}
                size="small"
              >
                <FontAwesomeIcon
                  icon={byPrefixAndName.fas['download']}
                  style={{ width: 16, height: 16 }}
                />
              </IconButton>
            </Tooltip>
          )}
          {onSave && (
            <Button
              variant="contained"
              disableElevation
              onClick={() => void save()}
              disabled={busy || !valid || !dirty}
              startIcon={
                busy ? (
                  <CircularProgress size={14} color="inherit" />
                ) : (
                  <FontAwesomeIcon
                    icon={byPrefixAndName.fas['floppy-disk']}
                    style={{ width: 14 }}
                  />
                )
              }
              sx={{ minWidth: { xs: 0, sm: 108 }, px: { xs: 1.5, sm: 2 }, borderRadius: 1.25 }}
            >
              {t('Save')}
            </Button>
          )}
          <Tooltip title={t('Close')}>
            <IconButton
              onClick={close}
              disabled={busy}
              aria-label={t('Close')}
              size="small"
              sx={{ ml: 0.5 }}
            >
              <FontAwesomeIcon
                icon={byPrefixAndName.fas['xmark']}
                style={{ width: 16, height: 16 }}
              />
            </IconButton>
          </Tooltip>
        </Stack>
        <BannerSlot />
        <ViewBanner open={!!error} status="error">
          {t(error)}
        </ViewBanner>
        <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          {content === null ? (
            !error && (
              <Stack sx={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 2 }}>
                <CircularProgress size={24} />
                <Typography variant="body2" color="text.secondary">
                  {t('Loading…')}
                </Typography>
              </Stack>
            )
          ) : (
            <OcNoteEditor
              value={content}
              disabled={!onSave}
              locked={busy}
              name={name}
              onValidityChange={setValid}
              onChange={(value) => {
                setContent(value)
                setDirty(true)
              }}
            />
          )}
        </Box>
        <Dialog
          open={discard}
          onClose={() => setDiscard(false)}
          maxWidth="xs"
          fullWidth
          aria-labelledby="note-discard-title"
        >
          <DialogTitle id="note-discard-title">{t('Discard unsaved changes?')}</DialogTitle>
          <DialogContent>
            <Typography variant="body2" color="text.secondary">
              {t('Your changes have not been saved yet.')}
            </Typography>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setDiscard(false)}>{t('Keep editing')}</Button>
            <Button color="error" variant="contained" onClick={onClose}>
              {t('Discard changes')}
            </Button>
          </DialogActions>
        </Dialog>
      </BannerScope>
    </Dialog>
  )
}

/** Files retain their download link; notes open a rich text reader/editor. */
export function NoteFileLink({
  name,
  url,
  children,
  onSave,
}: {
  name: string
  url: string
  children?: ReactNode
  onSave?: OcNoteDialogProps['onSave']
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Link
        href={url}
        download={name}
        onClick={
          isOcNote(name)
            ? (e) => {
                e.preventDefault()
                setOpen(true)
              }
            : undefined
        }
      >
        {children ?? name}
      </Link>
      {open && (
        <OcNoteDialog name={name} url={url} onSave={onSave} onClose={() => setOpen(false)} />
      )}
    </>
  )
}
