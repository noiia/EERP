'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import Autocomplete from '@mui/material/Autocomplete'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import FormControlLabel from '@mui/material/FormControlLabel'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useT } from '../../i18n/translate'
import { moduleRegistry } from '../../registry'
import { useRelationOps, type RelationRecord } from '../relation-ops'
import { useSessionStore } from '../session-store'
import { BannerScope, BannerSlot, ViewBanner } from '../banner'
import {
  diagramLabels,
  diagramSources,
  loadDiagram,
  parseSpec,
  text,
  type DiagramData,
  type DiagramKind,
  type DiagramSpec,
} from './model'
import { DiagramPreview, diagramPng } from './preview'

export interface DiagramPickerProps {
  initial: unknown
  editing: boolean
  onClose(): void
  onInsert(value: { image: string; width: number; height: number; data: string }): Promise<void>
}

export function DiagramPicker(props: DiagramPickerProps) {
  // Remount whenever the account or its permissions change. No fetched data
  // can be retained by a picker opened in a previous session.
  const identity = useSessionStore((s) => JSON.stringify(s.identity))
  return <Picker key={identity} {...props} />
}
function Picker({ initial, editing, onClose, onInsert }: DiagramPickerProps) {
  const t = useT(),
    tr = useRef(t)
  tr.current = t
  const ops = useRelationOps()
  const identity = useSessionStore((s) => s.identity)
  const sources = useMemo(
    () => diagramSources(moduleRegistry.buildRegistry(), identity?.permissions ?? []),
    [identity],
  )
  const saved = useMemo(() => parseSpec(initial), [initial])
  const [sourcePath, setSourcePath] = useState(
    sources.find((s) => s.path === saved?.source)?.path ?? sources[0]?.path ?? '',
  )
  const source = sources.find((s) => s.path === sourcePath)
  const [kind, setKind] = useState<DiagramKind>(saved?.kind ?? source?.kinds[0] ?? 'gantt')
  const [project, setProject] = useState<RelationRecord | null>(null)
  const [projects, setProjects] = useState<RelationRecord[]>([])
  const [search, setSearch] = useState('')
  const [searching, setSearching] = useState(false)
  const [title, setTitle] = useState(saved?.title ?? '')
  const [residual, setResidual] = useState(saved?.residual ?? false)
  const [snapshot, setSnapshot] = useState<{ key: string; data: DiagramData } | null>(null)
  const [loading, setLoading] = useState(false)
  const [inserting, setInserting] = useState(false)
  const [error, setError] = useState(
    saved && !sources.some((s) => s.path === saved.source)
      ? t('The original diagram source is unavailable or access was denied.')
      : '',
  )
  const [revision, setRevision] = useState(0)
  const preview = useRef<HTMLDivElement>(null)
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  const spec: DiagramSpec | null =
    source && project && source.kinds.includes(kind)
      ? {
          version: 1,
          source: source.path,
          projectId: project.id,
          kind,
          title: title.trim() || t(diagramLabels[kind]),
          residual,
        }
      : null

  useEffect(() => {
    if (!ops || !source || !saved || saved.source !== source.path) return
    let cancelled = false
    void ops.get(source.scopeEntity, saved.projectId).then(
      (p) => {
        if (!cancelled) setProject(p)
      },
      () => {
        if (!cancelled)
          setError(tr.current('The original project is unavailable or access was denied.'))
      },
    )
    return () => {
      cancelled = true
    }
  }, [ops, source, saved])

  useEffect(() => {
    if (!ops?.listPage || !source) return
    let cancelled = false
    setSearching(true)
    const timer = setTimeout(() => {
      void ops.listPage!(source.scopeEntity, {
        search: search ? { [source.labelField]: search } : undefined,
        order: source.labelField,
        pageSize: 30,
        page: 1,
      })
        .then(
          (r) => {
            if (!cancelled) setProjects(r.records)
          },
          () => {
            if (!cancelled) {
              setProjects([])
              setError(tr.current('Projects could not be loaded.'))
            }
          },
        )
        .finally(() => {
          if (!cancelled) setSearching(false)
        })
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [ops, source, search])

  const dataKey = spec ? JSON.stringify({ ...spec, title: '' }) : ''
  const loadKey = `${dataKey}/${revision}`
  const data = snapshot?.key === loadKey ? snapshot.data : null
  useEffect(() => {
    setSnapshot(null)
    if (!ops || !source || !dataKey) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError('')
    void loadDiagram(ops, source, JSON.parse(dataKey) as DiagramSpec)
      .then(
        (r) => {
          if (!cancelled) setSnapshot({ key: loadKey, data: r })
        },
        () => {
          if (!cancelled)
            setError(
              tr.current('The diagram could not be loaded. Check your access and try again.'),
            )
        },
      )
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [ops, source, dataKey, loadKey])

  const insert = async () => {
    const svg = preview.current?.querySelector('svg')
    if (!svg || !spec || !data || !identity) return
    setInserting(true)
    setError('')
    try {
      const png = await diagramPng(svg)
      if (!active.current) return
      await onInsert({ ...png, data: JSON.stringify(spec) })
    } catch {
      if (active.current) setError(tr.current('The diagram could not be inserted. Try again.'))
    } finally {
      if (active.current) setInserting(false)
    }
  }
  return (
    <Dialog
      open
      fullWidth
      maxWidth="lg"
      onClose={() => !inserting && onClose()}
      aria-labelledby="office-diagram-title"
    >
      <BannerScope>
        <DialogTitle id="office-diagram-title">
          {t(editing ? 'Update ERP diagram' : 'Insert ERP diagram')}
        </DialogTitle>
        <BannerSlot />
        <ViewBanner open={!!error} status="error">
          {error}
        </ViewBanner>
        <DialogContent dividers>
          {!sources.length || !ops?.listPage ? (
            <Typography sx={{ py: 4 }}>
              {t(
                'No diagram source is available for your account. Enable a module with project diagrams and check your permissions.',
              )}
            </Typography>
          ) : (
            <Stack spacing={2}>
              <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
                <TextField
                  select
                  label={t('Source')}
                  value={sourcePath}
                  disabled={inserting}
                  sx={{ flex: 1 }}
                  onChange={(e) => {
                    const s = sources.find((s) => s.path === e.target.value)!
                    setSourcePath(s.path)
                    setKind(s.kinds[0])
                    setProject(null)
                    setProjects([])
                    setSearch('')
                    setSnapshot(null)
                    setError('')
                  }}
                >
                  {sources.map((s) => (
                    <MenuItem key={s.path} value={s.path}>
                      {t(s.label)}
                    </MenuItem>
                  ))}
                </TextField>
                <Autocomplete
                  sx={{ flex: 1 }}
                  options={projects}
                  value={project}
                  loading={searching}
                  disabled={inserting || !source}
                  filterOptions={(o) => o}
                  isOptionEqualToValue={(a, b) => a.id === b.id}
                  getOptionLabel={(p) => text(p[source?.labelField ?? 'name']) || p.id}
                  onChange={(_, p) => setProject(p)}
                  onInputChange={(_, v, reason) => {
                    if (reason === 'input' || reason === 'clear') setSearch(v)
                  }}
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      label={t('Project')}
                      placeholder={t('Search projects…')}
                    />
                  )}
                />
                <TextField
                  select
                  label={t('Diagram')}
                  value={source?.kinds.includes(kind) ? kind : ''}
                  disabled={inserting}
                  sx={{ minWidth: 180 }}
                  onChange={(e) => setKind(e.target.value as DiagramKind)}
                >
                  {source?.kinds.map((k) => (
                    <MenuItem key={k} value={k}>
                      {t(diagramLabels[k])}
                    </MenuItem>
                  ))}
                </TextField>
              </Stack>
              <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
                <TextField
                  fullWidth
                  label={t('Title')}
                  placeholder={t(diagramLabels[kind])}
                  value={title}
                  disabled={inserting}
                  slotProps={{ htmlInput: { maxLength: 160 } }}
                  onChange={(e) => setTitle(e.target.value)}
                />
                {kind === 'risk' && (
                  <FormControlLabel
                    sx={{ flexShrink: 0 }}
                    control={
                      <Switch
                        checked={residual}
                        disabled={inserting}
                        onChange={(_, v) => setResidual(v)}
                      />
                    }
                    label={t('Residual risk')}
                  />
                )}
                <Button
                  disabled={!project || loading || inserting}
                  onClick={() => setRevision((v) => v + 1)}
                >
                  {t('Refresh')}
                </Button>
              </Stack>
              <Box
                ref={preview}
                sx={{
                  bgcolor: '#f1f5f9',
                  border: 1,
                  borderColor: 'divider',
                  borderRadius: 2,
                  p: 2,
                  minHeight: 280,
                  maxHeight: '55vh',
                  overflow: 'auto',
                  display: 'grid',
                  placeItems: 'center',
                }}
              >
                {loading ? (
                  <CircularProgress aria-label={t('Loading diagram')} />
                ) : data && spec && source ? (
                  <DiagramPreview data={data} spec={spec} source={source} t={t} />
                ) : (
                  <Typography color="text.secondary">
                    {t('Select a project to preview its diagram.')}
                  </Typography>
                )}
              </Box>
              <Typography variant="body2" color="text.secondary">
                {t(
                  'The diagram is embedded as a snapshot, including in PDF exports. Double-click it in Euro-Office to refresh its data or change its settings.',
                )}
              </Typography>
            </Stack>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, py: 2 }}>
          <Button onClick={onClose} disabled={inserting}>
            {t('Cancel')}
          </Button>
          <Button
            variant="contained"
            onClick={() => void insert()}
            disabled={!data || !spec || loading || inserting || !identity}
            startIcon={inserting ? <CircularProgress size={16} color="inherit" /> : undefined}
          >
            {t(editing ? 'Update diagram' : 'Insert diagram')}
          </Button>
        </DialogActions>
      </BannerScope>
    </Dialog>
  )
}
