'use client'
import { useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useRouter } from 'next/navigation'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import Tab from '@mui/material/Tab'
import Tabs from '@mui/material/Tabs'
import Typography from '@mui/material/Typography'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import { useTheme } from '@mui/material/styles'
import { usePermission } from '../../auth/Can'
import { serializeError, toApiError, type SerializedError } from '../../api/errors'
import type { RiskConfig } from '../../api/view-fields'
import { useT } from '../../i18n/translate'
import { erpPath } from '../../navigation'
import { ErrorAlert } from '../error-alert'
import { DiagramLoading } from '../diagram/diagram-canvas'
import { useFillHeight, usePhone } from '../use-phone'
import { useRelationOps } from '../relation-ops'
import { RelationCreateWizard } from '../relation-widgets'
import { Ishikawa } from './ishikawa'
import { RiskMatrix } from './risk-matrix'
import { RiskRegister } from './risk-register'
import { type RiskRow } from './scoring'

export interface RiskRendererProps {
  config: RiskConfig
  projectId: string
}

const PAGE_SIZE = 200
type Tab = 'matrix' | 'ishikawa' | 'register'
type Category = { id: string; name: string }

// Risk display mode of a project's risk list: criticity matrix, Ishikawa fishbone and the AMDEC register.
export function RiskRenderer({ config, projectId }: RiskRendererProps) {
  const t = useT()
  const ops = useRelationOps()
  const router = useRouter()
  const th = useTheme()
  const phone = usePhone()
  const [tab, setTab] = useState<Tab>('matrix')
  const [residual, setResidual] = useState(false)
  const [rows, setRows] = useState<RiskRow[] | null>(null)
  const [categories, setCategories] = useState<Category[]>([])
  const [project, setProject] = useState('')
  const [error, setError] = useState<SerializedError | null>(null)
  const [menu, setMenu] = useState<HTMLElement | null>(null)
  const [creating, setCreating] = useState(false)
  const [reload, setReload] = useState(0)
  const area = useRef<HTMLDivElement>(null)
  // The matrix export: both matrices side by side, drawn off screen only while exporting.
  const both = useRef<HTMLDivElement>(null)
  const [exportingBoth, setExportingBoth] = useState(false)
  const fill = useFillHeight(area, phone)
  const { entity, projectField, categoryEntity } = config
  const canCreate = usePermission(`${entity}:${entity}:write`)

  const listPage = ops?.listPage
  const get = ops?.get
  useEffect(() => {
    if (!listPage) return
    let cancelled = false
    const load = async () => {
      const out: RiskRow[] = []
      for (let page = 1; ; page++) {
        const res = await listPage(entity, { filter: { [projectField]: projectId }, order: '-criticity', pageSize: PAGE_SIZE, page })
        out.push(...(res.records as unknown as RiskRow[]))
        if (res.records.length < PAGE_SIZE) break
      }
      const cats = await listPage(categoryEntity, { order: 'name', pageSize: PAGE_SIZE, page: 1 })
      const proj = await get?.('project', projectId).catch(() => null)
      return { out, cats: cats.records as unknown as Category[], name: typeof proj?.name === 'string' ? proj.name : '' }
    }
    load().then(
      (r) => {
        if (cancelled) return
        setRows(r.out)
        setCategories(r.cats)
        setProject(r.name)
      },
      (e: unknown) => {
        if (cancelled) return
        setRows([])
        setError(serializeError(toApiError(e)))
      },
    )
    return () => {
      cancelled = true
    }
  }, [listPage, get, entity, projectField, categoryEntity, projectId, reload])

  if (!rows) return <DiagramLoading />
  const open = (id: string) => router.push(erpPath(config.formPath.replace(':id', id)))
  const exportable = tab !== 'register'
  const doExport = (kind: 'png' | 'pdf') => {
    setMenu(null)
    if (tab === 'matrix') flushSync(() => setExportingBoth(true))
    const el = tab === 'matrix' ? both.current : area.current
    if (!el) return setExportingBoth(false)
    const name = `${tab}-${projectId}`
    const bg = th.palette.background.paper
    const meta = { title: `${project} — ${tab === 'matrix' ? t('Matrix') : t('Ishikawa')}`, date: new Date(), legend: [], background: bg }
    const run = async () => {
      const { exportElementPdf, exportElementPng } = await import('../diagram/export')
      return kind === 'png' ? exportElementPng(el, name, bg) : exportElementPdf(el, meta, name)
    }
    run()
      .catch((e: unknown) => setError(serializeError(toApiError(e))))
      .finally(() => setExportingBoth(false))
  }

  return (
    <Box sx={{ p: 1 }}>
      <ErrorAlert error={error} />
      <Stack direction={phone ? 'column' : 'row'} sx={{ alignItems: phone ? 'stretch' : 'center', justifyContent: 'space-between', borderBottom: 1, borderColor: 'divider' }}>
        <Tabs value={tab} onChange={(_, v: Tab) => setTab(v)} variant={phone ? 'fullWidth' : 'standard'}>
          <Tab value="matrix" label={t('Matrix')} />
          <Tab value="ishikawa" label={t('Ishikawa')} />
          <Tab value="register" label={t('Register')} />
        </Tabs>
        <Stack direction="row" spacing={1} sx={phone ? { py: 1, flexWrap: 'wrap', '& .MuiButton-root, & .MuiToggleButton-root': { minHeight: 40, minWidth: 40 } } : undefined}>
          {canCreate && ops && <Button size="small" variant="contained" onClick={() => setCreating(true)}>{t('New risk')}</Button>}
          {tab === 'matrix' && (
            <ToggleButtonGroup size="small" exclusive value={residual ? 'after' : 'now'} onChange={(_, v: string | null) => v && setResidual(v === 'after')}>
              <ToggleButton value="now">{phone ? t('Now') : t('Current')}</ToggleButton>
              <ToggleButton value="after">{phone ? t('After') : t('After remediation')}</ToggleButton>
            </ToggleButtonGroup>
          )}
          {exportable && <Button size="small" onClick={(e) => setMenu(e.currentTarget)}>{t('Export')}</Button>}
        </Stack>
        <Menu open={!!menu} anchorEl={menu} onClose={() => setMenu(null)}>
          <MenuItem onClick={() => doExport('png')}>{t('Export PNG')}</MenuItem>
          <MenuItem onClick={() => doExport('pdf')}>{t('Export PDF')}</MenuItem>
        </Menu>
      </Stack>
      <Box sx={{ pt: 2, overflow: 'auto' }}>
        {/* The diagrams fill the view (centred, scaled to fit) instead of floating small in an empty zone. */}
        {tab === 'matrix' && <Box ref={area} sx={{ width: '100%', height: { xs: fill ?? '70vh', sm: '70vh' } }}><RiskMatrix rows={rows} residual={residual} onOpen={open} /></Box>}
        {tab === 'ishikawa' && <Box ref={area} sx={{ width: '100%', height: { xs: fill ?? '70vh', sm: '70vh' }, bgcolor: 'background.paper' }}><Ishikawa rows={rows} categories={categories} project={project} onOpen={open} /></Box>}
        {tab === 'register' && <RiskRegister rows={rows} categories={categories} onOpen={open} />}
      </Box>
      {exportingBoth && (
        // Off screen, but laid out at a fixed size; the inner box is the one captured (no offset in the image).
        <Box aria-hidden sx={{ position: 'fixed', left: -10000, top: 0 }}>
          <Box ref={both} data-testid="matrix-export" sx={{ display: 'flex', gap: 3, p: 2, width: 1600, bgcolor: 'background.paper' }}>
            {([false, true] as const).map((r) => (
              <Box key={String(r)} sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="h6" align="center">{r ? t('After remediation') : t('Current')}</Typography>
                <Box sx={{ height: 520 }}><RiskMatrix rows={rows} residual={r} onOpen={open} wide /></Box>
              </Box>
            ))}
          </Box>
        </Box>
      )}
      {creating && ops ? (
        <RelationCreateWizard
          rel={{ entity, kind: 'many2one' }}
          ops={ops}
          preset={{ [projectField]: projectId }}
          hidden={[projectField]}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false)
            setReload((n) => n + 1)
          }}
        />
      ) : null}
    </Box>
  )
}
