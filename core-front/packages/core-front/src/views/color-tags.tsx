'use client'
import { useState } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import { useT } from '../i18n/translate'
import { BannerScope, BannerSlot, ViewBanner } from './banner'

// Shared visuals of color tags (relation/colortags): a chip's dot, the
// create dialog, and the backgrounds Gantt bars and card ribbons paint.

/** Colors reach CSS: only plain #rrggbb ones are ever used. */
export function isHex6Color(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)
}

/** One color, or equal hard-edged stripes of several along `direction`. */
export function colorStripes(colors: string[], direction: 'to right' | 'to bottom'): string {
  if (colors.length === 1) return colors[0]
  const step = 100 / colors.length
  const stops = colors.map(
    (c, i) => `${c} ${+(i * step).toFixed(4)}% ${+((i + 1) * step).toFixed(4)}%`,
  )
  return `linear-gradient(${direction}, ${stops.join(', ')})`
}

export function ColorDot({ color }: { color: string }) {
  return (
    <Box
      component="span"
      data-testid="color-dot"
      sx={{ width: 10, height: 10, borderRadius: '50%', flexShrink: 0, display: 'inline-block' }}
      style={{ background: color }}
    />
  )
}

/** A 1px band along a card's top edge (the card must be position: relative). */
export function ColorRibbon({ colors }: { colors: string[] | undefined }) {
  if (!colors || colors.length === 0) return null
  return (
    <Box
      data-testid="color-ribbon"
      aria-hidden
      sx={{ position: 'absolute', top: 0, left: 0, right: 0, pointerEvents: 'none' }}
      style={{ height: '1px', background: colorStripes(colors, 'to right') }}
    />
  )
}

/** "Create" for a color tag: a name and a color, nothing else. */
export function ColorTagDialog({
  title,
  initialName,
  onClose,
  onSubmit,
}: {
  title: string
  initialName: string
  onClose: () => void
  /** Rejects with the refusal, shown in the dialog. */
  onSubmit: (name: string, color: string) => Promise<void>
}) {
  const t = useT()
  const [name, setName] = useState(initialName)
  const [color, setColor] = useState('#1976d2')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setBusy(true)
    try {
      await onSubmit(name.trim(), color)
      onClose()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth>
      <BannerScope>
        <Box>
          <DialogTitle>{title}</DialogTitle>
          <DialogContent>
            <Stack spacing={2} sx={{ pt: 1 }}>
              <BannerSlot sx={{ mb: 0 }} />
              <ViewBanner status="error" open={Boolean(error)}>
                {error}
              </ViewBanner>
              <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
                <Box
                  component="input"
                  type="color"
                  aria-label={t('Color')}
                  value={color}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setColor(e.target.value)}
                  sx={{
                    width: 40,
                    height: 40,
                    p: 0,
                    border: 'none',
                    bgcolor: 'transparent',
                    cursor: 'pointer',
                  }}
                />
                <TextField
                  label={t('Name')}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                  fullWidth
                  size="small"
                />
              </Stack>
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={onClose}>{t('Cancel')}</Button>
            <Button
              variant="contained"
              disabled={busy || name.trim() === ''}
              onClick={() => void submit()}
            >
              {t('Create')}
            </Button>
          </DialogActions>
        </Box>
      </BannerScope>
    </Dialog>
  )
}
