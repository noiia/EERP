'use client'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import IconButton from '@mui/material/IconButton'
import Link from '@mui/material/Link'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { faArrowDown, faFileLines, faXmark } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from './icons'
import { BannerScope, BannerSlot, ViewBanner } from './banner'
import { useT } from '../i18n/translate'
import { useI18nStore } from '../i18n/i18n-store'
import { parseError } from '../api/errors'
import { lazyComponent } from './lazy-component'
import type { DiagramPickerProps } from './office-diagrams/picker'
import { useDiagramBridge } from './office-diagrams/bridge'
import { useSessionStore } from './session-store'

const DiagramPicker = lazyComponent<DiagramPickerProps>(() =>
  import('./office-diagrams/picker').then((m) => m.DiagramPicker),
)

export type OfficeSource = { kind: 'team-file' | 'team-attachment' | 'attachment'; id: string }
export const isOfficeFile = (name: string) =>
  /\.(docx?|xlsx?|pptx?|od[tsp]|rtf|txt|csv|pdf|vsdx)$/i.test(name)

interface OfficeInstance {
  destroyEditor(): void
}
interface OfficeAPI {
  DocEditor: new (id: string, config: Record<string, unknown>) => OfficeInstance
}
type OfficeWindow = Window & { DocsAPI?: OfficeAPI }
interface OfficeSession {
  apiUrl: string
  config: Record<string, unknown>
  editable: boolean
}

// One shared script per configured server; failed loads can be retried.
let scriptPromise: Promise<OfficeAPI> | undefined
let scriptURL: string | undefined
function loadOffice(url: string): Promise<OfficeAPI> {
  if (scriptPromise && scriptURL === url) return scriptPromise
  scriptURL = url
  scriptPromise = new Promise<OfficeAPI>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = url
    script.async = true
    script.onload = () => {
      const api = (window as OfficeWindow).DocsAPI
      if (api) resolve(api)
      else {
        scriptPromise = undefined
        script.remove()
        reject(new Error('Office API unavailable'))
      }
    }
    script.onerror = () => {
      scriptPromise = undefined
      script.remove()
      reject(new Error('Office server unavailable'))
    }
    document.head.append(script)
  })
  return scriptPromise
}

export function OfficeDialog({
  name,
  url,
  source,
  onClose,
}: {
  name: string
  url: string
  source: OfficeSource
  onClose: () => void
}) {
  const t = useT()
  const translations = useRef(t)
  translations.current = t
  const locale = useI18nStore((s) => s.locale)
  const account = useSessionStore((s) => `${s.identity?.tenantId}/${s.identity?.userId}`)
  const hostId = `office-${useId().replace(/:/g, '')}`
  const instance = useRef<OfficeInstance | null>(null)
  const host = useRef<HTMLDivElement>(null)
  const [documentReady, setDocumentReady] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editable, setEditable] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [confirmAction, setConfirmAction] = useState<'close' | 'retry' | null>(null)
  const [revision, setRevision] = useState(0)
  const diagrams = useDiagramBridge(
    host,
    editable && documentReady,
    `${source.kind}/${source.id}/${locale}/${revision}/${account}`,
  )
  const [pickerReady, setPickerReady] = useState('')
  const diagramRequest = diagrams.request
  const closeDiagram = diagrams.close
  useEffect(() => {
    if (!diagramRequest) return
    setError('')
    let cancelled = false
    // Resolve the chunk before rendering the engine's synchronous lazy widget.
    // This also gives a failed download a scoped error and a clean retry.
    void DiagramPicker.preload().then(
      () => {
        if (!cancelled) setPickerReady(diagramRequest.id)
      },
      () => {
        if (!cancelled) {
          closeDiagram()
          setError(translations.current('The diagram editor could not be loaded. Try again.'))
        }
      },
    )
    return () => {
      cancelled = true
    }
  }, [diagramRequest, closeDiagram])
  const close = useRef(onClose)
  close.current = onClose
  const requestClose = useRef(() => {})
  requestClose.current = () => (dirty ? setConfirmAction('close') : close.current())

  useEffect(() => {
    const t = translations.current
    let cancelled = false
    const controller = new AbortController()
    setLoading(true)
    setError('')
    setDirty(false)
    setDocumentReady(false)
    const timer = window.setTimeout(() => {
      if (!cancelled) {
        setLoading(false)
        setError(t('Euro-Office did not respond. Try again or download the file.'))
      }
    }, 45000)
    void (async () => {
      try {
        const query = new URLSearchParams({ lang: locale ?? 'en' })
        const res = await fetch(
          `/api/office/${source.kind}/${encodeURIComponent(source.id)}/session?${query}`,
          { signal: controller.signal, cache: 'no-store' },
        )
        if (!res.ok) throw await parseError(res)
        const session = (await res.json()) as OfficeSession
        const api = await loadOffice(session.apiUrl)
        if (cancelled) return
        setEditable(session.editable)
        // The signed configuration is supplied by Go. Events stay local and
        // cannot change document permissions, storage URLs or the signed key.
        instance.current = new api.DocEditor(hostId, {
          ...session.config,
          events: {
            onAppReady: () => {
              clearTimeout(timer)
              if (!cancelled) {
                setLoading(false)
                setError('')
              }
            },
            onDocumentReady: () => {
              if (!cancelled) setDocumentReady(true)
            },
            onDocumentStateChange: (event: { data: boolean }) => {
              if (!cancelled) setDirty(event.data)
            },
            onError: () => {
              clearTimeout(timer)
              if (!cancelled) {
                setError(
                  t(
                    'Euro-Office reported an error. Keep the document open or download a copy from its File menu.',
                  ),
                )
                setLoading(false)
              }
            },
            onRequestClose: () => {
              if (!cancelled) requestClose.current()
            },
          },
        })
      } catch (e) {
        clearTimeout(timer)
        if (cancelled) return
        setError(
          e instanceof Error && 'code' in e && e.code === 'OFFICE_UNAVAILABLE'
            ? t('Euro-Office is not configured.')
            : t('The document could not be opened. Try again or download the file.'),
        )
        setLoading(false)
      }
    })()
    return () => {
      cancelled = true
      controller.abort()
      clearTimeout(timer)
      instance.current?.destroyEditor()
      instance.current = null
    }
  }, [source.kind, source.id, locale, revision, hostId, account])

  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  return (
    <Dialog
      open
      fullScreen
      onClose={() => requestClose.current()}
      aria-labelledby={`${hostId}-title`}
    >
      <BannerScope>
        <Stack
          direction="row"
          sx={{
            height: 64,
            px: 2,
            gap: 1.5,
            alignItems: 'center',
            borderBottom: 1,
            borderColor: 'divider',
          }}
        >
          <Box
            sx={{ bgcolor: 'action.selected', color: 'primary.main', p: 1.2, borderRadius: 1.5 }}
          >
            <FontAwesomeIcon icon={faFileLines} />
          </Box>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography id={`${hostId}-title`} sx={{ fontWeight: 600 }} noWrap>
              {name}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Euro-Office · {t(editable ? 'Editing' : 'Read only')}
            </Typography>
          </Box>
          <Button
            component="a"
            href={url}
            startIcon={<FontAwesomeIcon icon={faArrowDown} />}
            sx={{ display: { xs: 'none', sm: 'inline-flex' } }}
          >
            {t('Download')}
          </Button>
          <IconButton aria-label={t('Close')} onClick={() => requestClose.current()}>
            <FontAwesomeIcon icon={faXmark} />
          </IconButton>
        </Stack>
        <BannerSlot />
        <ViewBanner open={!!error} status="error">
          {error}{' '}
          <Button
            size="small"
            onClick={() => (dirty ? setConfirmAction('retry') : setRevision((v) => v + 1))}
          >
            {t('Retry')}
          </Button>{' '}
          <Button size="small" component="a" href={url}>
            {t('Download')}
          </Button>
        </ViewBanner>
        <Box
          ref={host}
          sx={{ flex: 1, minHeight: 0, position: 'relative', bgcolor: 'background.default' }}
        >
          {loading && (
            <Stack
              role="status"
              aria-label={t('Opening document')}
              sx={{
                position: 'absolute',
                inset: 0,
                alignItems: 'center',
                justifyContent: 'center',
                gap: 2,
              }}
            >
              <CircularProgress />
              <Typography>{t('Opening document')}</Typography>
            </Stack>
          )}
          <Box sx={{ height: '100%', visibility: loading ? 'hidden' : 'visible' }}>
            <div id={hostId} style={{ height: '100%' }} />
          </Box>
        </Box>
        {diagrams.request && pickerReady === diagrams.request.id && (
          <DiagramPicker
            key={diagrams.request.id}
            initial={diagrams.request.initial}
            editing={diagrams.request.editing}
            onClose={diagrams.close}
            onInsert={diagrams.insert}
          />
        )}
        {diagrams.request && pickerReady !== diagrams.request.id && (
          <Dialog open onClose={diagrams.close} aria-label={t('Loading diagram editor')}>
            <DialogContent>
              <CircularProgress aria-label={t('Loading diagram editor')} />
            </DialogContent>
            <DialogActions>
              <Button onClick={diagrams.close}>{t('Cancel')}</Button>
            </DialogActions>
          </Dialog>
        )}
        <Dialog open={confirmAction !== null} onClose={() => setConfirmAction(null)}>
          <DialogTitle>
            {t(confirmAction === 'retry' ? 'Reload document?' : 'Close document?')}
          </DialogTitle>
          <DialogContent>
            {t(
              'Changes are still being sent to Euro-Office. Keep this document open until synchronization is complete.',
            )}
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setConfirmAction(null)}>{t('Keep editing')}</Button>
            <Button
              onClick={() => {
                if (confirmAction === 'retry') {
                  setConfirmAction(null)
                  setRevision((v) => v + 1)
                } else close.current()
              }}
            >
              {t(confirmAction === 'retry' ? 'Reload anyway' : 'Close anyway')}
            </Button>
          </DialogActions>
        </Dialog>
      </BannerScope>
    </Dialog>
  )
}

export function OfficeFileLink({
  name,
  url,
  source,
  children,
  onClosed,
}: {
  name: string
  url: string
  source: OfficeSource
  children?: ReactNode
  onClosed?: () => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Link
        href={url}
        underline="hover"
        sx={{ cursor: 'pointer', overflowWrap: 'anywhere' }}
        onClick={(event) => {
          if (
            isOfficeFile(name) &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.shiftKey &&
            !event.altKey &&
            !(event.button > 0)
          ) {
            event.preventDefault()
            setOpen(true)
          }
        }}
      >
        {children ?? name}
      </Link>
      {open && (
        <OfficeDialog
          name={name}
          url={url}
          source={source}
          onClose={() => {
            setOpen(false)
            onClosed?.()
          }}
        />
      )}
    </>
  )
}
