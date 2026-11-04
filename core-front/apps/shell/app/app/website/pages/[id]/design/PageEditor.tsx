'use client'
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import ReactGridLayout, { getCompactor, useContainerWidth, verticalCompactor } from 'react-grid-layout'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Container from '@mui/material/Container'
import Drawer from '@mui/material/Drawer'
import IconButton from '@mui/material/IconButton'
import List from '@mui/material/List'
import ListItemButton from '@mui/material/ListItemButton'
import ListItemIcon from '@mui/material/ListItemIcon'
import ListItemText from '@mui/material/ListItemText'
import Skeleton from '@mui/material/Skeleton'
import Stack from '@mui/material/Stack'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import useMediaQuery from '@mui/material/useMediaQuery'
import { alpha, useTheme, type Theme } from '@mui/material/styles'
import { BannerScope, BannerSlot, byPrefixAndName, createPictureClient, erpPath, FontAwesomeIcon, IntentLink, useT, ViewBanner } from '@eerp/core-front'
import type { PublishedTable } from '@/lib/website-settings'
import { previewBlock } from '@/website/editor-actions'
import { addBlock, applyGeometry, GRID, removeBlock, rowsPx, updateConfig } from '@/website/layout-ops'
import { SITE_PHONE_TYPE, SiteTheme } from '@/website/SiteTheme'
import { stackOrder, type Block } from '@/website/types'
import { BLOCK_LABELS, BlockIcon, BlockPalette, blockCaption } from './BlockPalette'
import { BlockSettings, PublishFields } from './BlockSettings'
import { InspectorHeader, InspectorSection } from './Inspector'

// The page builder: ERP chrome (toolbar, settings panel) around a pasteboard holding
// the page itself — rendered in the site's own theme (SiteTheme), so what is drawn on
// the sheet is the site as visitors see it and everything around it is the tool. The
// ERP accent marks the editor's own affordances only (hover, selection, block tags,
// resize handles); it never appears inside the page.

const PANEL_WIDTH = 340
/** The phone preview's width: a common phone's CSS width. */
const PHONE_WIDTH = 390
// With a background section on the page, blocks must be able to sit over it: free
// placement (no packing, overlap allowed) instead of the default vertical packing.
const OVERLAP = getCompactor(null, true)
const pictures = createPictureClient()

/** The page's background picture through the staff BFF (the public route would 404
 * on an unpublished page), or null. */
function useBackgroundUrl(pageId: string, on: boolean): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    if (on) pictures.find({ table: 'website_page', recordId: pageId, field: 'background' }).then((m) => live && setUrl(m ? pictures.url(m.id) : null), () => {})
    return () => { live = false }
  }, [pageId, on])
  return on ? url : null
}

/** Live preview: the public site's own BlockView, rendered server-side by a
 * Server Action (300 ms debounce, keyed by the block's type + config: moving or
 * resizing a block must not refetch its preview). */
function BlockPreview({ block, version }: { block: Block; version: number }) {
  const t = useT()
  // version: bumped when the editor publishes fields — the same config then reads more data.
  const key = JSON.stringify({ type: block.type, config: block.config, version })
  const [shown, setShown] = useState<{ key: string; node: ReactNode } | null>(null)
  useEffect(() => {
    let live = true
    const timer = setTimeout(() => {
      previewBlock(block, {}).then((node) => live && setShown({ key, node }), () => live && setShown({ key, node: null }))
    }, 300)
    return () => { live = false; clearTimeout(timer) }
  }, [key]) // `key` is what the preview depends on (type + config)
  if (shown?.key !== key) return <Skeleton variant="rectangular" height="100%" sx={{ minHeight: 48 }} />
  // Inert: a preview link must not navigate away from the editor nor take keyboard
  // focus (the block frame is the focus stop), and clicks select the block.
  return (
    <Box inert sx={{ pointerEvents: 'none', height: '100%' }}>
      {shown.node ?? (
        <Stack spacing={0.5} sx={{ height: '100%', minHeight: 48, alignItems: 'center', justifyContent: 'center', textAlign: 'center', p: 2, color: 'text.secondary' }}>
          <BlockIcon type={block.type} />
          <Typography variant="body2">{t('Nothing to show yet: configure this block.')}</Typography>
        </Stack>
      )}
    </Box>
  )
}

type Viewport = 'desktop' | 'phone'

export function PageEditor({ pageId, slug, title, layout: initial, background, published, save }: {
  pageId: string
  slug: string
  title: string
  layout: Block[]
  /** The page's background picture flag and parallax (set in the page form). */
  background?: { on: boolean; parallax: boolean }
  published: PublishedTable[]
  save: (layout: Block[]) => Promise<string | null>
}) {
  const t = useT()
  const theme = useTheme()
  const narrow = useMediaQuery((th: Theme) => th.breakpoints.down('md'))
  const { width, containerRef, mounted } = useContainerWidth({ measureBeforeMount: true })
  const [layout, setLayout] = useState(initial)
  const [savedJSON, setSavedJSON] = useState(() => JSON.stringify(initial))
  const [selected, setSelected] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [viewport, setViewport] = useState<Viewport>('desktop')
  const [pub, setPub] = useState(published) // updated in place when a block publishes fields
  const [pubVersion, setPubVersion] = useState(0)
  const dirty = JSON.stringify(layout) !== savedJSON
  const phone = narrow || viewport === 'phone' // the stacked projection: a real phone, or its preview
  const bgUrl = useBackgroundUrl(pageId, !!background?.on)
  const pagePub = pub.find((p) => p.table === 'website_page')
  // Sections first: later children paint on top, so blocks over a section stay clickable.
  const painted = [...layout.filter((b) => b.type === 'section'), ...layout.filter((b) => b.type !== 'section')]
  // The editor's own accent, read from the ERP theme here: inside the sheet the site theme rules.
  const accent = theme.palette.primary.main
  const onAccent = theme.palette.primary.contrastText

  useEffect(() => {
    if (!dirty) return
    const guard = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [dirty])

  async function onSave() {
    if (saving) return
    setSaving(true)
    const err = await save(layout)
    setSaving(false)
    // '' = a failure with no server message: the fallback is translated here, client-side.
    if (err !== null) return setError(err || t('Could not save.'))
    setError(null)
    setSavedJSON(JSON.stringify(layout))
  }
  // Shortcuts: Ctrl/Cmd+S saves, Esc closes the block settings (not while a menu,
  // a list or a dialog is open, nor in a field — Esc belongs to those first).
  const saveRef = useRef(onSave)
  saveRef.current = onSave
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void saveRef.current()
      } else if (e.key === 'Escape' && !(e.target instanceof Element && e.target.closest('input, textarea, [role="menu"], [role="listbox"], [role="dialog"]'))) {
        setSelected(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /** Selects a block and brings it into view (from the block list). */
  const reveal = (id: string) => {
    setSelected(id)
    const el = document.getElementById(`editor-frame-${id}`)
    el?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
    el?.focus({ preventScroll: true })
  }

  const block = layout.find((b) => b.id === selected)
  const settings = (
    <Box data-testid="block-settings">
      {block ? (
        <>
          <InspectorHeader icon={<BlockIcon type={block.type} />} title={t(BLOCK_LABELS[block.type])} caption={blockCaption(block)} onClose={() => setSelected(null)} />
          <Box sx={{ p: 2 }}>
            <BlockSettings
              block={block}
              published={pub}
              onPublished={(tb) => { setPub((p) => p.map((x) => (x.table === tb.table ? tb : x))); setPubVersion((v) => v + 1) }}
              onChange={(config) => setLayout((l) => updateConfig(l, block.id, config))}
              onDelete={() => { setLayout((l) => removeBlock(l, block.id)); setSelected(null) }}
            />
          </Box>
        </>
      ) : (
        <>
          <InspectorHeader icon={<FontAwesomeIcon icon={byPrefixAndName.fas.file} />} title={t('Page')} caption={`/${slug}`} />
          <Stack spacing={2} sx={{ p: 2 }}>
            <InspectorSection title={t('Blocks')} hint={t('Select a block on the page or in this list to configure it.')}>
              {layout.length === 0 ? (
                <Typography variant="body2" color="text.secondary">{t('No blocks yet.')}</Typography>
              ) : (
                <List dense disablePadding aria-label={t('Blocks')} sx={{ mx: -1 }}>
                  {stackOrder(layout).map((b) => (
                    <ListItemButton key={b.id} onClick={() => reveal(b.id)} sx={{ borderRadius: 1, py: 0.25 }}>
                      <ListItemIcon sx={{ minWidth: 30, color: 'text.secondary' }}><BlockIcon type={b.type} /></ListItemIcon>
                      <ListItemText primary={t(BLOCK_LABELS[b.type])} secondary={blockCaption(b) || undefined}
                        slotProps={{ secondary: { noWrap: true } }} />
                    </ListItemButton>
                  ))}
                </List>
              )}
            </InspectorSection>
            <InspectorSection title={t('Page background')}
              hint={t('Set a background picture (and parallax) in the page form; add a Background section block for a colored band.')}>
              <Button size="small" variant="outlined" component={IntentLink} href={erpPath(`/website/pages/${pageId}`)} sx={{ alignSelf: 'flex-start' }}>
                {t('Open the page form')}
              </Button>
              {background?.on && pagePub && (
                <PublishFields table={pagePub} used={['background', 'background_parallax']}
                  onPublished={(tb) => setPub((p) => p.map((x) => (x.table === tb.table ? tb : x)))} />
              )}
            </InspectorSection>
            <Typography variant="caption" color="text.secondary">{t('Ctrl+S saves the page. Esc closes the block settings.')}</Typography>
          </Stack>
        </>
      )}
    </Box>
  )

  const frame = (b: Block, extra?: object) => {
    const on = selected === b.id
    const caption = blockCaption(b)
    return {
      id: `editor-frame-${b.id}`,
      onClick: () => setSelected(b.id),
      onKeyDown: (e: ReactKeyboardEvent) => {
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setSelected(b.id) }
      },
      tabIndex: 0,
      role: 'button',
      'aria-pressed': on,
      'aria-label': caption ? `${t(BLOCK_LABELS[b.type])}: ${caption}` : t(BLOCK_LABELS[b.type]),
      'data-testid': `editor-block-${b.id}`,
      sx: {
        position: 'relative', overflow: 'hidden', cursor: on ? 'move' : 'pointer', borderRadius: '2px',
        // Idle: a faint dashed edge, so an empty or transparent block can still be found.
        // Hover: the accent edge and the block's tag. Selected: a thicker edge, tag kept.
        outline: on ? `2px solid ${accent}` : `1px dashed ${alpha(theme.palette.grey[600], 0.35)}`,
        outlineOffset: on ? 0 : -1,
        '&:hover, &:focus-visible': { outline: `${on ? 2 : 1}px solid ${accent}`, outlineOffset: 0 },
        '& > .block-tag': { opacity: on ? 1 : 0 },
        '&:hover > .block-tag, &:focus-visible > .block-tag': { opacity: 1 },
        ...extra,
      },
      tag: (
        <Box className="block-tag" aria-hidden sx={{
          position: 'absolute', top: 0, left: 0, zIndex: 3, pointerEvents: 'none', display: 'flex', alignItems: 'center', gap: 0.75,
          maxWidth: '100%', px: 0.75, py: 0.25, borderBottomRightRadius: 4, bgcolor: accent, color: onAccent,
          fontFamily: theme.typography.fontFamily, fontSize: 11, fontWeight: 600, lineHeight: 1.6, whiteSpace: 'nowrap',
          transition: 'opacity 120ms',
        }}>
          <BlockIcon type={b.type} />{t(BLOCK_LABELS[b.type])}
        </Box>
      ),
    }
  }
  const framed = (b: Block, extra?: object) => {
    const { tag, ...props } = frame(b, extra)
    return <Box key={b.id} {...props}>{tag}<BlockPreview block={b} version={pubVersion} /></Box>
  }

  const empty = layout.length === 0 && (
    <Stack spacing={1.5} sx={{ alignItems: 'center', textAlign: 'center', py: 10, px: 2, color: 'text.secondary' }}>
      <Box sx={{ fontSize: 28, opacity: 0.6 }}><FontAwesomeIcon icon={byPrefixAndName.fas['layer-group']} /></Box>
      <Typography variant="h5" component="p" color="text.primary">{t('This page has no blocks yet')}</Typography>
      <Typography variant="body2" sx={{ maxWidth: '44ch' }}>{t('Add a hero, a text or any other block, then drag it into place and resize it from its corner.')}</Typography>
    </Stack>
  )

  // The editor's own banner scope: its notices (save result, the settings panel's
  // warnings) show in the canvas column, between the screen's left edge and the
  // fixed settings panel — the ERP page's slot spans the full width, under it.
  return (
    <BannerScope>
    <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      <Box sx={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <Stack component="header" direction="row" spacing={1} sx={{
            px: 2, py: 1, alignItems: 'center', flexWrap: 'wrap', rowGap: 1, borderBottom: 1, borderColor: 'divider', bgcolor: 'background.paper',
          }}>
            <Tooltip title={t('Back to the page form')}>
              <IconButton component={IntentLink} href={erpPath(`/website/pages/${pageId}`)} aria-label={t('Back')} size="small" sx={{ ml: -0.5 }}>
                <FontAwesomeIcon icon={byPrefixAndName.fas['arrow-left']} />
              </IconButton>
            </Tooltip>
            <Box sx={{ flex: 1, minWidth: 160 }}>
              <Typography variant="h5" component="h1" noWrap>{title}</Typography>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                <Typography variant="caption" color="text.secondary" noWrap>/{slug}</Typography>
                {/* The save state, announced politely: the one place a save's outcome shows when it succeeds. */}
                <Typography variant="caption" role="status" aria-live="polite" noWrap
                  sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, color: dirty ? 'warning.main' : 'text.secondary' }}>
                  <Box component="span" aria-hidden sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: dirty ? 'warning.main' : 'success.main' }} />
                  {saving ? t('Saving…') : dirty ? t('Unsaved changes') : t('All changes saved')}
                </Typography>
              </Stack>
            </Box>
            {!narrow && (
              <ToggleButtonGroup size="small" exclusive value={viewport} aria-label={t('Preview width')}
                onChange={(_, v: Viewport | null) => v && setViewport(v)}>
                <ToggleButton value="desktop" aria-label={t('Desktop')}>
                  <Tooltip title={t('Desktop: drag and resize blocks')}><Box component="span" sx={{ display: 'inline-flex' }}><FontAwesomeIcon icon={byPrefixAndName.fas.desktop} /></Box></Tooltip>
                </ToggleButton>
                <ToggleButton value="phone" aria-label={t('Phone')}>
                  <Tooltip title={t('Phone: blocks stacked as visitors see them')}><Box component="span" sx={{ display: 'inline-flex' }}><FontAwesomeIcon icon={byPrefixAndName.fas['mobile-screen']} /></Box></Tooltip>
                </ToggleButton>
              </ToggleButtonGroup>
            )}
            <BlockPalette onAdd={(type) => setLayout((l) => addBlock(l, type))} />
            <Button href={`/${slug}`} target="_blank" rel="noopener" endIcon={<FontAwesomeIcon icon={byPrefixAndName.fas['arrow-up-right-from-square']} />}>
              {t('View on site')}
            </Button>
            <Button variant="contained" onClick={() => void onSave()} disabled={saving}
              startIcon={<FontAwesomeIcon icon={byPrefixAndName.fas['floppy-disk']} />}>{t('Save')}</Button>
          </Stack>
          {/* One slot, one inset: every banner the editor raises has the same width. */}
          <BannerSlot sx={{ mx: 2, mt: 1 }} />
          <ViewBanner status="error" open={error !== null} onClose={() => setError(null)}>{error}</ViewBanner>
          {/* The pasteboard: a recessed surface, so the page reads as an object being edited. */}
          <Box onClick={(e) => { if (e.target === e.currentTarget) setSelected(null) }} sx={{
            flex: 1, p: { xs: 1, md: 3 },
            bgcolor: theme.palette.mode === 'light' ? alpha(theme.palette.text.primary, 0.06) : alpha('#000', 0.35),
          }}>
            <SiteTheme sx={{
              mx: 'auto', maxWidth: phone ? PHONE_WIDTH : 1200, minHeight: 360, borderRadius: phone && !narrow ? 3 : 0.5,
              boxShadow: '0 1px 2px rgba(0,0,0,0.08), 0 12px 32px -16px rgba(0,0,0,0.35)', transition: 'max-width 200ms',
              ...(phone && !narrow && SITE_PHONE_TYPE),
              ...(bgUrl && { backgroundImage: `url("${bgUrl}")`, backgroundSize: 'cover', backgroundPosition: 'center', backgroundAttachment: background?.parallax ? 'fixed' : 'scroll' }),
            }}>
              {/* Same width as the public site's Container, so blocks wrap as they will there. */}
              <Container maxWidth="lg" sx={{ py: phone ? 2 : 4, px: phone ? 2 : undefined, minWidth: 0 }}>
                <Box ref={containerRef} sx={{
                  // react-grid-layout's own chrome, in the editor's accent.
                  '& .react-grid-placeholder': { bgcolor: accent, opacity: 0.18, borderRadius: '2px' },
                  '& .react-grid-item > .react-resizable-handle': { zIndex: 4 },
                  '& .react-grid-item > .react-resizable-handle::after': { borderColor: accent, width: 7, height: 7 },
                }}>
                  {empty}
                  {phone ? (
                    // Phones: the public site's stacked projection, (y, x) order, no drag.
                    <Stack spacing={2}>
                      {stackOrder(layout).map((b) => framed(b, { minHeight: rowsPx(b.h) }))}
                    </Stack>
                  ) : mounted ? (
                    <ReactGridLayout
                      layout={layout.map((b) => ({ i: b.id, x: b.x, y: b.y, w: b.w, h: b.h }))}
                      width={width}
                      // margin 8 = the public grid's gap (GRID.gap).
                      gridConfig={{ cols: GRID.cols, rowHeight: GRID.rowHeight, margin: [GRID.gap, GRID.gap], containerPadding: [0, 0] }}
                      dragConfig={{ enabled: true }}
                      resizeConfig={{ enabled: true, handles: ['se', 'e', 's'] }}
                      compactor={layout.some((b) => b.type === 'section') ? OVERLAP : verticalCompactor}
                      onLayoutChange={(rgl) => setLayout((l) => applyGeometry(l, rgl))}
                    >
                      {painted.map((b) => framed(b))}
                    </ReactGridLayout>
                  ) : null}
                </Box>
              </Container>
            </SiteTheme>
          </Box>
        </Box>
        {!narrow && (
          // Fixed below the top bar (dense Toolbar = 48px), so the settings stay beside
          // whatever the user scrolled to. Not `sticky`: the ERP layout's overflowX box
          // is a scroll container that never scrolls, which would pin it to the page top.
          // The empty spacer keeps the canvas from running under it.
          <Box sx={{ width: PANEL_WIDTH, flexShrink: 0 }}>
            <Box component="aside" aria-label={t('Settings')} sx={{
              position: 'fixed', top: 48, right: 0, bottom: 0, width: PANEL_WIDTH, overflowY: 'auto',
              zIndex: (th) => th.zIndex.drawer, borderLeft: 1, borderColor: 'divider', bgcolor: 'background.paper',
            }}>
              {settings}
            </Box>
          </Box>
        )}
      </Box>
      {narrow && (
        <Drawer anchor="bottom" open={block != null} onClose={() => setSelected(null)} slotProps={{ paper: { sx: { maxHeight: '80vh' } } }}>
          {settings}
        </Drawer>
      )}
    </Box>
    </BannerScope>
  )
}
