'use client'
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import type { Theme } from '@mui/material/styles'
import {
  createPictureClient,
  type PictureAnchor,
  type PictureClient,
  type PictureMeta,
} from '../api/pictures-client'
import { useT } from '../i18n/translate'
import { fieldLabel, type FieldDescriptor } from './descriptor'
import type { WidgetProps } from './widgets'

// Picture-backed boolean widgets (docs/roadmaps/field-widgets.md, Phase 3).
// The DB column stores only the flag; the bytes live in the picture service,
// one picture per (table, record, field) anchor. The service is AUTHORITATIVE:
// on load each widget resolves the anchor and reconciles the draft flag with
// what actually exists, so a failed upload can never leave a `true` without an
// image. Uploads happen at interaction time — before the record PUT that
// commits the boolean — which is exactly the mandated commit order.

const PictureClientContext = createContext<PictureClient | null>(null)

/** Override the widgets' picture client (tests stub it; the default hits /api/pictures). */
export function PictureClientProvider({
  client,
  children,
}: {
  client: PictureClient
  children: ReactNode
}) {
  return <PictureClientContext.Provider value={client}>{children}</PictureClientContext.Provider>
}

export function usePictureClient(): PictureClient {
  const injected = useContext(PictureClientContext)
  const fallback = useMemo(() => createPictureClient(), [])
  return injected ?? fallback
}

/**
 * The Settings -> Apps admin-configured box size for THIS form's owning
 * module (already resolved server-side through the Base cascade — see
 * loader.tsx's loadPictureSize), or null when no admin has configured
 * anything at any level. FormRenderer mounts this once per form; a widget
 * with no Provider above it (an isolated test, a form outside the module
 * catch-all) reads null, same as "nothing configured".
 */
const PictureSizeContext = createContext<{ width: number; height: number } | null>(null)

export function PictureSizeProvider({
  size,
  children,
}: {
  size: { width: number; height: number } | null | undefined
  children: ReactNode
}) {
  return <PictureSizeContext.Provider value={size ?? null}>{children}</PictureSizeContext.Provider>
}

/**
 * The widget's service state: where the picture hangs (null until the record
 * first saves — no id, no anchor), the current picture, and load/IO plumbing.
 * Shared by both widgets; `sync` is called after every upload/delete so the
 * draft flag always mirrors the service.
 */
function usePictureState(
  { field, value, onChange, entity, recordId }: WidgetProps,
) {
  const client = usePictureClient()
  const anchor: PictureAnchor | null =
    entity && recordId ? { table: entity, recordId, field: field.name } : null

  const [meta, setMeta] = useState<PictureMeta | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The draft flag follows the service, never the other way around.
  const sync = (found: PictureMeta | null) => {
    setMeta(found)
    if (Boolean(value) !== (found != null)) onChange(found != null)
  }

  useEffect(() => {
    if (!anchor) return
    let cancelled = false
    client
      .find(anchor)
      .then((found) => {
        if (!cancelled) sync(found)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
    // Deliberately keyed on the anchor alone: the lookup runs once per anchor,
    // not on every draft edit.
  }, [anchor?.table, anchor?.recordId, anchor?.field])

  const run = async (io: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await io()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return { client, anchor, meta, busy, error, sync, run }
}

function WidgetFrame({
  label,
  error,
  children,
}: {
  label: string | null
  error: string | null
  children: ReactNode
}) {
  return (
    <Box>
      {label != null && (
        <Typography variant="caption" color="text.secondary" component="legend">
          {label}
        </Typography>
      )}
      {children}
      {error ? (
        <Typography variant="caption" color="error" sx={{ display: 'block', mt: 0.5 }}>
          {error}
        </Typography>
      ) : null}
    </Box>
  )
}

function UnsavedRecordHint() {
  const t = useT()
  return (
    <Typography variant="body2" color="text.secondary">
      {t('Available once the record has been saved.')}
    </Typography>
  )
}

// ── boolean/picture ───────────────────────────────────────────────────────────

const PICTURE_ACCEPT = 'image/png,image/jpeg,image/webp'
/** The widget's innermost fallback, below both an admin's Settings -> Apps
 * setting and a module author's widgetOptions — exported so that Settings ->
 * Apps' own UI (PictureSizeSettings, apps/shell) can show an accurate "using
 * the default" hint instead of duplicating this literal. */
export const DEFAULT_PICTURE_WIDTH = 160
export const DEFAULT_PICTURE_HEIGHT = 96

/**
 * The placeholder/thumbnail box size, in precedence order: an admin's runtime
 * Settings -> Apps override (PictureSizeContext — resolved through the Base
 * cascade, so it already reflects "this app's own setting, else Base")
 * beats the module author's declared `widgetOptions: { width, height }`
 * (same convention as stars' `{ max: 5 }`), which beats the widget's own
 * hardcoded floor. */
function pictureSize(
  field: FieldDescriptor,
  override: { width: number; height: number } | null,
): { width: number; height: number } {
  if (override) return override
  const { width, height } = field.widgetOptions ?? {}
  return {
    width: typeof width === 'number' ? width : DEFAULT_PICTURE_WIDTH,
    height: typeof height === 'number' ? height : DEFAULT_PICTURE_HEIGHT,
  }
}

/** Shared "ring" framing for both the empty placeholder and the loaded
 * thumbnail, so swapping between the two states doesn't jump the outline. */
const PICTURE_RING_SX = {
  border: 2,
  borderColor: 'divider',
  borderRadius: 1,
  boxShadow: (theme: Theme) => `0 0 0 3px ${theme.palette.primary.main}22`,
}

export function BooleanPictureWidget(props: WidgetProps) {
  const t = useT()
  const { field, disabled } = props
  const { client, anchor, meta, busy, error, sync, run } = usePictureState(props)
  const sizeOverride = useContext(PictureSizeContext)
  const { width, height } = pictureSize(field, sizeOverride)

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !anchor) return
    void run(async () => {
      sync(await client.upload(anchor, file, file.name))
    })
  }

  const onDelete = () => {
    if (!meta) return
    void run(async () => {
      await client.remove(meta.id)
      sync(null)
    })
  }

  return (
    <WidgetFrame label={field.hideLabel ? null : t(fieldLabel(field))} error={error}>
      {!anchor ? (
        <UnsavedRecordHint />
      ) : (
        <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
          {meta ? (
            <Box
              component="img"
              src={client.url(meta.id)}
              alt={t(fieldLabel(field))}
              sx={{ width, height, objectFit: 'cover', ...PICTURE_RING_SX }}
            />
          ) : (
            <Box
              data-testid="picture-placeholder"
              sx={{
                width,
                height,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                ...PICTURE_RING_SX,
              }}
            >
              <Typography variant="caption" color="text.disabled">
                {t('No image')}
              </Typography>
            </Box>
          )}
          <Button component="label" variant="outlined" size="small" disabled={disabled || busy}>
            {meta ? t('Replace') : t('Upload')}
            <input hidden type="file" accept={PICTURE_ACCEPT} onChange={onFile} />
          </Button>
          {meta ? (
            <Button color="error" size="small" disabled={disabled || busy} onClick={onDelete}>
              {t('Delete')}
            </Button>
          ) : null}
        </Stack>
      )}
    </WidgetFrame>
  )
}

// ── boolean/signature ─────────────────────────────────────────────────────────

const SIGNATURE_WIDTH = 400
const SIGNATURE_HEIGHT = 160

export function BooleanSignatureWidget(props: WidgetProps) {
  const t = useT()
  const { field, onChange, disabled } = props
  const { client, anchor, meta, busy, error, sync, run } = usePictureState(props)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  const [hasStrokes, setHasStrokes] = useState(false)

  const strokeTo = (e: React.PointerEvent<HTMLCanvasElement>, begin: boolean) => {
    const canvas = canvasRef.current
    // jsdom has no 2d context — the state machine must not depend on one.
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    if (begin) {
      ctx.beginPath()
      ctx.moveTo(x, y)
    } else {
      ctx.lineTo(x, y)
      ctx.stroke()
    }
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (disabled || busy) return
    drawing.current = true
    if (!hasStrokes) {
      setHasStrokes(true)
      // Any stroke means "signed" — the flag commits with the record PUT.
      onChange(true)
    }
    strokeTo(e, true)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (drawing.current) strokeTo(e, false)
  }

  const onPointerUp = () => {
    drawing.current = false
  }

  const clearCanvas = () => {
    const canvas = canvasRef.current
    canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
  }

  const onDone = () => {
    const canvas = canvasRef.current
    if (!canvas || !anchor) return
    canvas.toBlob((blob) => {
      if (!blob) return
      void run(async () => {
        sync(await client.upload(anchor, blob, `${field.name}.png`))
        setHasStrokes(false)
        clearCanvas()
      })
    }, 'image/png')
  }

  const onReset = () => {
    void run(async () => {
      if (meta) await client.remove(meta.id)
      clearCanvas()
      setHasStrokes(false)
      sync(null)
    })
  }

  return (
    <WidgetFrame label={field.hideLabel ? null : t(fieldLabel(field))} error={error}>
      {!anchor ? (
        <UnsavedRecordHint />
      ) : (
        <Stack spacing={1} sx={{ alignItems: 'flex-start' }}>
          {meta ? (
            <Box
              component="img"
              src={client.url(meta.id)}
              alt={t(fieldLabel(field))}
              sx={{
                width: SIGNATURE_WIDTH,
                maxWidth: '100%',
                height: 'auto',
                border: 1,
                borderColor: 'divider',
                borderRadius: 1,
              }}
            />
          ) : (
            <Box
              component="canvas"
              ref={canvasRef}
              width={SIGNATURE_WIDTH}
              height={SIGNATURE_HEIGHT}
              role="img"
              aria-label={t(fieldLabel(field))}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={onPointerUp}
              sx={{
                border: 1,
                borderColor: 'divider',
                borderRadius: 1,
                touchAction: 'none',
                cursor: disabled ? 'not-allowed' : 'crosshair',
                maxWidth: '100%',
              }}
            />
          )}
          <Stack direction="row" spacing={1}>
            {meta ? null : (
              <Button
                variant="outlined"
                size="small"
                disabled={disabled || busy || !hasStrokes}
                onClick={onDone}
              >
                {t('Done')}
              </Button>
            )}
            <Button
              color="error"
              size="small"
              disabled={disabled || busy || (!hasStrokes && !meta)}
              onClick={onReset}
            >
              {t('Reset')}
            </Button>
          </Stack>
        </Stack>
      )}
    </WidgetFrame>
  )
}
