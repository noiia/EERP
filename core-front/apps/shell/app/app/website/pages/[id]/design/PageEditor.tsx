'use client'
import { useEffect, useState, type ReactNode } from 'react'
import ReactGridLayout, { useContainerWidth, verticalCompactor } from 'react-grid-layout'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Container from '@mui/material/Container'
import Drawer from '@mui/material/Drawer'
import Skeleton from '@mui/material/Skeleton'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import useMediaQuery from '@mui/material/useMediaQuery'
import type { Theme } from '@mui/material/styles'
import { erpPath, useT } from '@eerp/core-front'
import type { PublishedTable } from '@/lib/website-settings'
import { previewBlock } from '@/website/editor-actions'
import { addBlock, applyGeometry, removeBlock, updateConfig } from '@/website/layout-ops'
import { stackOrder, type Block } from '@/website/types'
import { BlockPalette } from './BlockPalette'
import { BlockSettings } from './BlockSettings'

const PANEL_WIDTH = 340

/** Live preview: the public site's own BlockView, rendered server-side by a
 * Server Action (300 ms debounce, keyed by the block's type + config: moving or
 * resizing a block must not refetch its preview). */
function BlockPreview({ block }: { block: Block }) {
  const t = useT()
  const key = JSON.stringify({ type: block.type, config: block.config })
  const [shown, setShown] = useState<{ key: string; node: ReactNode } | null>(null)
  useEffect(() => {
    let live = true
    const timer = setTimeout(() => {
      previewBlock(block, {}).then((node) => live && setShown({ key, node }), () => live && setShown({ key, node: null }))
    }, 300)
    return () => { live = false; clearTimeout(timer) }
  }, [key]) // `key` is what the preview depends on (type + config)
  if (shown?.key !== key) return <Skeleton variant="rectangular" height="100%" />
  // Inert: a preview link must not navigate away from the editor, and clicks select the block.
  return (
    <Box sx={{ pointerEvents: 'none', height: '100%' }}>
      {shown.node ?? <Typography variant="body2" color="text.secondary">{t('Nothing to show yet: configure this block.')}</Typography>}
    </Box>
  )
}

export function PageEditor({ pageId, slug, title, layout: initial, published, save }: {
  pageId: string
  slug: string
  title: string
  layout: Block[]
  published: PublishedTable[]
  save: (layout: Block[]) => Promise<string | null>
}) {
  const t = useT()
  const phone = useMediaQuery((theme: Theme) => theme.breakpoints.down('md'))
  const { width, containerRef, mounted } = useContainerWidth({ measureBeforeMount: true })
  const [layout, setLayout] = useState(initial)
  const [savedJSON, setSavedJSON] = useState(() => JSON.stringify(initial))
  const [selected, setSelected] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)
  const [pub, setPub] = useState(published) // updated in place when a block publishes fields
  const dirty = JSON.stringify(layout) !== savedJSON

  useEffect(() => {
    if (!dirty) return
    const guard = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [dirty])

  async function onSave() {
    setSaving(true)
    const err = await save(layout)
    setSaving(false)
    // '' = a failure with no server message: the fallback is translated here, client-side.
    if (err !== null) return setStatus({ ok: false, text: err || t('Could not save.') })
    setSavedJSON(JSON.stringify(layout))
    setStatus({ ok: true, text: t('Saved.') })
  }

  const block = layout.find((b) => b.id === selected)
  const settings = (
    <Box data-testid="block-settings" sx={{ p: 2 }}>
      {block ? (
        <BlockSettings
          block={block}
          published={pub}
          onPublished={(tb) => setPub((p) => p.map((x) => (x.table === tb.table ? tb : x)))}
          onChange={(config) => setLayout((l) => updateConfig(l, block.id, config))}
          onDelete={() => { setLayout((l) => removeBlock(l, block.id)); setSelected(null) }}
        />
      ) : (
        <Typography color="text.secondary">{t('Select a block to configure it.')}</Typography>
      )}
    </Box>
  )
  const frame = (b: Block, extra?: object) => ({
    onClick: () => setSelected(b.id),
    'data-testid': `editor-block-${b.id}`,
    sx: {
      overflow: 'hidden', cursor: 'pointer', outline: selected === b.id ? '2px solid' : '1px dashed',
      outlineColor: selected === b.id ? 'primary.main' : 'divider', ...extra,
    },
  })

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      <Box sx={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Stack direction="row" spacing={1} sx={{ p: 2, alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
            <Typography variant="h5" component="h1" sx={{ flex: 1 }}>{title}</Typography>
            <BlockPalette onAdd={(type) => setLayout((l) => addBlock(l, type))} />
            <Button variant="contained" onClick={() => void onSave()} disabled={saving}>{t('Save')}</Button>
            <Button href={`/${slug}`} target="_blank" rel="noopener">{t('View on site')}</Button>
            <Button href={erpPath(`/website/pages/${pageId}`)}>{t('Back')}</Button>
          </Stack>
          {status && <Alert severity={status.ok ? 'success' : 'error'} sx={{ mx: 2 }} onClose={() => setStatus(null)}>{status.text}</Alert>}
          {/* Same width as the public site's Container, so blocks wrap as they will there. */}
          <Container maxWidth="lg" sx={{ py: 2, flex: 1, minWidth: 0 }}>
            <Box ref={containerRef}>
              {phone ? (
                // Phones: the public site's stacked projection, (y, x) order, no drag.
                <Stack spacing={2}>
                  {stackOrder(layout).map((b) => (
                    <Box key={b.id} {...frame(b, { minHeight: b.h * 40 })}><BlockPreview block={b} /></Box>
                  ))}
                </Stack>
              ) : mounted ? (
                <ReactGridLayout
                  layout={layout.map((b) => ({ i: b.id, x: b.x, y: b.y, w: b.w, h: b.h }))}
                  width={width}
                  // margin 16 = the public grid's gap (theme spacing 2).
                  gridConfig={{ cols: 12, rowHeight: 40, margin: [16, 16], containerPadding: [0, 0] }}
                  dragConfig={{ enabled: true }}
                  resizeConfig={{ enabled: true, handles: ['se', 'e', 's'] }}
                  compactor={verticalCompactor}
                  onLayoutChange={(rgl) => setLayout((l) => applyGeometry(l, rgl))}
                >
                  {layout.map((b) => (
                    <Box key={b.id} {...frame(b)}><BlockPreview block={b} /></Box>
                  ))}
                </ReactGridLayout>
              ) : null}
            </Box>
          </Container>
        </Box>
        {!phone && (
          // Fixed below the top bar (dense Toolbar = 48px), so the settings stay beside
          // whatever the user scrolled to. Not `sticky`: the ERP layout's overflowX box
          // is a scroll container that never scrolls, which would pin it to the page top.
          // The empty spacer keeps the canvas from running under it.
          <Box sx={{ width: PANEL_WIDTH, flexShrink: 0 }}>
            <Box component="aside" sx={{
              position: 'fixed', top: 48, right: 0, bottom: 0, width: PANEL_WIDTH, overflowY: 'auto',
              zIndex: (theme) => theme.zIndex.drawer, borderLeft: 1, borderColor: 'divider', bgcolor: 'background.paper',
            }}>
              {settings}
            </Box>
          </Box>
        )}
      </Box>
      {phone && (
        <Drawer anchor="bottom" open={block != null} onClose={() => setSelected(null)}>
          {settings}
        </Drawer>
      )}
    </Box>
  )
}
