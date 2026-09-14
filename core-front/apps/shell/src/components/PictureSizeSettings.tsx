'use client'
import { useState } from 'react'
import Alert from '@mui/material/Alert'
import Checkbox from '@mui/material/Checkbox'
import FormControlLabel from '@mui/material/FormControlLabel'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { DEFAULT_PICTURE_HEIGHT, DEFAULT_PICTURE_WIDTH, useT } from '@eerp/core-front'
import { setModulePictureSize, type PictureSize } from '@/lib/app-settings'

// Settings -> Apps: the boolean/picture widget's box size. `module === 'base'`
// edits the workspace-wide default directly (no override concept — there's
// nothing above Base to inherit from but the frontend's own hardcoded
// DEFAULT_PICTURE_WIDTH/HEIGHT). Any other module shows an override toggle:
// unchecked inherits the resolved `base` value (shown as a hint, not
// editable); checked writes this module's own value, which
// PictureSizeContext (core-front) then prefers over Base for every
// boolean/picture field this module's forms render.

export default function PictureSizeSettings({
  module,
  canEdit,
  initialOverride,
  base,
}: {
  module: string
  canEdit: boolean
  /** This module's OWN stored value (null = unset). For module === 'base'
   * this IS the value being edited, not an "override" of anything. */
  initialOverride: PictureSize | null
  /** The resolved Base value, for the inherited-value hint. Irrelevant (and
   * unused) when module === 'base'. */
  base: PictureSize | null
}) {
  const t = useT()
  const isBase = module === 'base'
  const [overridden, setOverridden] = useState(isBase || initialOverride != null)
  const effectiveBase = base ?? { width: DEFAULT_PICTURE_WIDTH, height: DEFAULT_PICTURE_HEIGHT }
  const [size, setSize] = useState<PictureSize>(initialOverride ?? effectiveBase)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save(next: PictureSize | null) {
    setError(null)
    setSaving(true)
    const result = await setModulePictureSize(module, next)
    setSaving(false)
    if (!result.ok) setError(result.message)
  }

  function onToggleOverride(checked: boolean) {
    setOverridden(checked)
    void save(checked ? size : null)
  }

  function onBlurDimension() {
    if (overridden) void save(size)
  }

  const disabled = !canEdit || saving || (!isBase && !overridden)

  return (
    <Stack spacing={2}>
      <Typography variant="subtitle1">{t('Picture size')}</Typography>
      <Typography variant="body2" color="text.secondary">
        {isBase
          ? t('The default box size for every boolean/picture field, unless an app overrides it.')
          : t('Override the default picture box size for this app.')}
      </Typography>

      {!isBase && (
        <FormControlLabel
          control={
            <Checkbox
              checked={overridden}
              disabled={!canEdit || saving}
              onChange={(e) => onToggleOverride(e.target.checked)}
            />
          }
          label={t('Override for this app')}
        />
      )}
      {!isBase && !overridden && (
        <Typography variant="caption" color="text.secondary">
          {t('Inherits Base:')} {effectiveBase.width}×{effectiveBase.height}
        </Typography>
      )}

      <Stack direction="row" spacing={2}>
        <TextField
          label={t('Width')}
          type="number"
          size="small"
          sx={{ maxWidth: 140 }}
          disabled={disabled}
          value={overridden ? size.width : effectiveBase.width}
          onChange={(e) => setSize((s) => ({ ...s, width: Number(e.target.value) }))}
          onBlur={onBlurDimension}
          slotProps={{ htmlInput: { min: 16, max: 2000 } }}
        />
        <TextField
          label={t('Height')}
          type="number"
          size="small"
          sx={{ maxWidth: 140 }}
          disabled={disabled}
          value={overridden ? size.height : effectiveBase.height}
          onChange={(e) => setSize((s) => ({ ...s, height: Number(e.target.value) }))}
          onBlur={onBlurDimension}
          slotProps={{ htmlInput: { min: 16, max: 2000 } }}
        />
      </Stack>

      {!canEdit && (
        <Typography variant="body2" color="text.secondary">
          {t('Changing the picture size requires the settings:apps:write permission.')}
        </Typography>
      )}
      {error && <Alert severity="error">{error}</Alert>}
    </Stack>
  )
}
