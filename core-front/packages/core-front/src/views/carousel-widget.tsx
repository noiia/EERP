'use client'
import { useEffect, useState } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import IconButton from '@mui/material/IconButton'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import type { PictureAnchor } from '../api/pictures-client'
import { useT } from '../i18n/translate'
import { fieldLabel } from './descriptor'
import { byPrefixAndName, FontAwesomeIcon } from './icons'
import { usePictureClient } from './picture-widgets'
import { MissingOpsHint, UnsavedHint, relationOf } from './relation-widgets'
import { useRelationOps, type RelationRecord } from './relation-ops'
import type { WidgetProps } from './widgets'

// relation/carousel — a one2many field rendered as a photo gallery instead
// of the stock DataGrid (RelationListWidget): each embedded row is one
// photo, its actual bytes living on the picture service (see
// internal/pictures) anchored at (relatedEntity, row.id, pictureField) —
// the SAME boolean/picture contract every other picture-backed field uses,
// just resolved by hand here (CarouselSlide) instead of through the full
// WidgetProps-driven BooleanPictureWidget, which expects to own a whole form
// field rather than one row inside an embedded list.
//
// widgetOptions.max caps how many rows this field will hold (property_
// management's Photos pages: 20 on the property, 10 on equipment) — the
// "+ Add photo" button disables past it, client-side only, same posture
// every other widgetOptions cap in this codebase takes (e.g. stars' `max`).
// widgetOptions.pictureField names which field on the related entity holds
// the picture anchor; defaults to 'picture'.

const CAROUSEL_PAGE_SIZE = 100
const DEFAULT_PICTURE_FIELD = 'picture'
const DEFAULT_MAX = 20

function sortByPosition(rows: RelationRecord[]): RelationRecord[] {
  return [...rows].sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0))
}

/**
 * One slide's own picture tile: an upload label while empty, the image +
 * a delete button once set. `onRemoveRow` is called AFTER the picture
 * (if any) is removed, so the parent can then delete the now-photo-less row
 * — one user action (the × button) removes both the bytes and the row.
 */
function CarouselSlide({
  anchor,
  disabled,
  onRemoveRow,
}: {
  anchor: PictureAnchor
  disabled?: boolean
  onRemoveRow: () => void
}) {
  const t = useT()
  const client = usePictureClient()
  const [pictureId, setPictureId] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    client
      .find(anchor)
      .then((meta) => {
        if (!cancelled) {
          setPictureId(meta?.id ?? null)
          setLoaded(true)
        }
      })
      .catch(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
    // Deliberately keyed on the anchor alone, like every other picture-backed
    // widget's own lookup effect.
  }, [anchor.table, anchor.recordId, anchor.field])

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setBusy(true)
    void client
      .upload(anchor, file, file.name)
      .then((meta) => setPictureId(meta.id))
      .finally(() => setBusy(false))
  }

  const onDeleteSlide = () => {
    setBusy(true)
    void (pictureId ? client.remove(pictureId) : Promise.resolve()).then(onRemoveRow)
  }

  const interactive = !(disabled || busy)

  if (!loaded) return null

  return (
    <Box sx={{ position: 'relative', width: 280, height: 200, flexShrink: 0 }}>
      {pictureId ? (
        <>
          <Box
            component="img"
            src={client.url(pictureId)}
            alt={t('Photo')}
            sx={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 1 }}
          />
          <IconButton
            aria-label={t('Delete')}
            size="small"
            onClick={onDeleteSlide}
            disabled={!interactive}
            sx={{
              position: 'absolute',
              top: 4,
              right: 4,
              bgcolor: 'error.light',
              color: 'error.dark',
              '&:hover': { bgcolor: 'error.light' },
            }}
          >
            <FontAwesomeIcon icon={byPrefixAndName.fas['xmark']} size="sm" />
          </IconButton>
        </>
      ) : (
        <Box
          component="label"
          aria-label={t('Upload')}
          sx={{
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: 2,
            borderColor: 'divider',
            borderRadius: 1,
            cursor: interactive ? 'pointer' : 'default',
          }}
        >
          <Box component="span" sx={{ color: 'text.disabled' }}>
            <FontAwesomeIcon icon={byPrefixAndName.fas['upload']} size="2x" />
          </Box>
          <Box
            component="input"
            hidden
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={onFile}
            disabled={!interactive}
          />
          {/* This slide's own row still has no picture — deletable without
              the picture-removal round trip onDeleteSlide takes. */}
          <IconButton
            aria-label={t('Delete')}
            size="small"
            onClick={onRemoveRow}
            disabled={!interactive}
            sx={{ position: 'absolute', top: 4, right: 4 }}
          >
            <FontAwesomeIcon icon={byPrefixAndName.fas['xmark']} size="sm" />
          </IconButton>
        </Box>
      )}
    </Box>
  )
}

export function RelationCarouselWidget({ field, disabled, recordId }: WidgetProps) {
  const t = useT()
  const ops = useRelationOps()
  const rel = relationOf(field)
  const inverseField = rel.inverseField as string // registration validated presence
  const max = typeof field.widgetOptions?.max === 'number' ? field.widgetOptions.max : DEFAULT_MAX
  const pictureField =
    typeof field.widgetOptions?.pictureField === 'string' ? field.widgetOptions.pictureField : DEFAULT_PICTURE_FIELD

  const [rows, setRows] = useState<RelationRecord[]>([])
  const [index, setIndex] = useState(0)

  useEffect(() => {
    if (!ops || !recordId) return
    let cancelled = false
    ops
      .list(rel.entity, { filter: { [inverseField]: recordId }, pageSize: CAROUSEL_PAGE_SIZE })
      .then((found) => {
        if (!cancelled) setRows(sortByPosition(found))
      })
      .catch(() => {
        if (!cancelled) setRows([])
      })
    return () => {
      cancelled = true
    }
  }, [ops, rel.entity, inverseField, recordId])

  if (!ops) return <MissingOpsHint label={field.hideLabel ? null : t(fieldLabel(field))} />
  if (!recordId) return <UnsavedHint label={field.hideLabel ? null : t(fieldLabel(field))} />

  const current = index < rows.length ? rows[index] : undefined
  const atMax = rows.length >= max

  const addPhoto = () => {
    if (atMax || !ops) return
    void ops.create(rel.entity, { [inverseField]: recordId, position: rows.length }).then((created) => {
      setRows((prev) => [...prev, created])
      setIndex(rows.length)
    })
  }

  const removeCurrent = () => {
    if (!current || !ops) return
    void ops.remove(rel.entity, current.id).then(() => {
      setRows((prev) => prev.filter((r) => r.id !== current.id))
      setIndex((i) => Math.min(i, Math.max(0, rows.length - 2)))
    })
  }

  return (
    <Box>
      {!field.hideLabel && (
        <Typography variant="caption" color="text.secondary" component="legend">
          {t(fieldLabel(field))}
        </Typography>
      )}
      {rows.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          {t('No photos yet.')}
        </Typography>
      ) : (
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1 }}>
          <IconButton
            aria-label={t('Previous')}
            disabled={index === 0}
            onClick={() => setIndex((i) => i - 1)}
          >
            <FontAwesomeIcon icon={byPrefixAndName.fas['chevron-left']} />
          </IconButton>
          {current && (
            <CarouselSlide
              anchor={{ table: rel.entity, recordId: current.id, field: pictureField }}
              disabled={disabled}
              onRemoveRow={removeCurrent}
            />
          )}
          <IconButton
            aria-label={t('Next')}
            disabled={index >= rows.length - 1}
            onClick={() => setIndex((i) => i + 1)}
          >
            <FontAwesomeIcon icon={byPrefixAndName.fas['chevron-right']} />
          </IconButton>
        </Stack>
      )}
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <Typography variant="caption" color="text.secondary">
          {rows.length} / {max}
        </Typography>
        <Button size="small" onClick={addPhoto} disabled={disabled || atMax}>
          {t('Add photo')}
        </Button>
      </Stack>
    </Box>
  )
}
