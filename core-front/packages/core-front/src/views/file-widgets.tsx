'use client'
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import IconButton from '@mui/material/IconButton'
import Link from '@mui/material/Link'
import Stack from '@mui/material/Stack'
import {
  createAttachmentClient,
  type AttachmentAnchor,
  type AttachmentClient,
  type AttachmentMeta,
} from '../api/attachments-client'
import { useT } from '../i18n/translate'
import { fieldLabel } from './descriptor'
import { useEntityRefreshStore } from './entity-refresh-store'
import { byPrefixAndName, FontAwesomeIcon } from './icons'
import { UnsavedRecordHint, WidgetFrame } from './picture-widgets'
import type { WidgetProps } from './widgets'

// boolean/file — the non-image sibling of picture-widgets.tsx's
// BooleanPictureWidget: same "DB column stores only the flag, the service is
// authoritative, upload happens before the record PUT commits the flag"
// contract, over internal/attachments instead of internal/pictures. Renders
// as a filename + download link instead of an <img> thumbnail — a PDF has no
// inline preview worth building here.

const AttachmentClientContext = createContext<AttachmentClient | null>(null)

/** Override the widget's attachment client (tests stub it; the default hits /api/attachments). */
export function AttachmentClientProvider({
  client,
  children,
}: {
  client: AttachmentClient
  children: ReactNode
}) {
  return <AttachmentClientContext.Provider value={client}>{children}</AttachmentClientContext.Provider>
}

export function useAttachmentClient(): AttachmentClient {
  const injected = useContext(AttachmentClientContext)
  const fallback = useMemo(() => createAttachmentClient(), [])
  return injected ?? fallback
}

/** Mirrors picture-widgets.tsx's usePictureState exactly, scoped to attachments. */
function useAttachmentState({ field, value, onChange, entity, recordId }: WidgetProps) {
  const client = useAttachmentClient()
  const anchor: AttachmentAnchor | null =
    entity && recordId ? { table: entity, recordId, field: field.name } : null

  const [meta, setMeta] = useState<AttachmentMeta | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const sync = (found: AttachmentMeta | null) => {
    setMeta(found)
    if (Boolean(value) !== (found != null)) onChange(found != null)
  }

  // Bumped by a host action that replaced this anchor's file OUTSIDE this
  // widget's own upload flow (e.g. propertymanagement.regenerateReceiptPdf
  // uploading straight through createAttachmentClient()) — see
  // entity-refresh-store.ts.
  const refreshSignal = useEntityRefreshStore((s) => s.bumps[entity ?? ''])

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
    // Deliberately keyed on the anchor (+ the refresh signal) alone: the
    // lookup runs once per anchor, not on every draft edit.
  }, [anchor?.table, anchor?.recordId, anchor?.field, refreshSignal])

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

export function BooleanFileWidget(props: WidgetProps) {
  const t = useT()
  const { field, disabled } = props
  const { client, anchor, meta, busy, error, sync, run } = useAttachmentState(props)

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

  const interactive = !(disabled || busy)

  return (
    <WidgetFrame label={field.hideLabel ? null : t(fieldLabel(field))} error={error}>
      {!anchor ? (
        <UnsavedRecordHint />
      ) : (
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          {meta ? (
            <>
              <Link
                href={client.url(meta.id)}
                // download hints the filename to browsers that honor it; the
                // real guarantee is Go's own Content-Disposition header on
                // the streamed response (a same-origin BFF route, so this
                // isn't a cross-origin download the attribute can't reach).
                download={meta.filename}
                sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}
              >
                <FontAwesomeIcon icon={byPrefixAndName.fas['file']} size="sm" />
                {meta.filename}
              </Link>
              <Button component="label" size="small" disabled={!interactive}>
                {t('Replace')}
                <Box
                  component="input"
                  type="file"
                  onChange={onFile}
                  disabled={!interactive}
                  sx={{ display: 'none' }}
                />
              </Button>
              <IconButton aria-label={t('Delete')} onClick={onDelete} disabled={!interactive} size="small">
                <FontAwesomeIcon icon={byPrefixAndName.fas['xmark']} size="sm" />
              </IconButton>
            </>
          ) : (
            <Button component="label" variant="outlined" size="small" disabled={!interactive}>
              {t('Upload')}
              <Box
                component="input"
                type="file"
                onChange={onFile}
                disabled={!interactive}
                sx={{ display: 'none' }}
              />
            </Button>
          )}
        </Stack>
      )}
    </WidgetFrame>
  )
}
