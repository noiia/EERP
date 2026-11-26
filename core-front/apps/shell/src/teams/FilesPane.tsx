'use client'
import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Breadcrumbs from '@mui/material/Breadcrumbs'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import IconButton from '@mui/material/IconButton'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Link from '@mui/material/Link'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import TextField from '@mui/material/TextField'
import InputAdornment from '@mui/material/InputAdornment'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import {
  faArrowsUpDownLeftRight,
  faDownload,
  faEllipsisVertical,
  faFileCirclePlus,
  faFolderPlus,
  faMagnifyingGlass,
  faPen,
  faShareNodes,
  faTrash,
  faUpload,
  type IconDefinition,
} from '@fortawesome/free-solid-svg-icons'
import useMediaQuery from '@mui/material/useMediaQuery'
import { useTheme } from '@mui/material/styles'
import {
  erpPath,
  FontAwesomeIcon,
  IntentLink,
  OfficeFileLink,
  OfficeDialog,
  T,
  useSessionStore,
  useT,
} from '@eerp/core-front'
import {
  createFolder,
  deleteFile,
  deleteFolder,
  listFiles,
  searchFiles,
  createDocument,
  updateFile,
  updateFolder,
  uploadFile,
  type FileSearch,
  type Folder,
  type TeamFile,
  type FolderListing,
  type Role,
} from './client'
import { FileIcon } from './FileIcon'
import { FolderPicker } from './FolderPicker'
import { ShareDialog } from './ShareDialog'

export const formatSize = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${Math.round(n / 1024)} KB`
      : `${(n / 1048576).toFixed(1)} MB`

const when = (iso?: string) => (iso ? new Date(iso).toLocaleString() : '')

type Hit = { path?: { id: string; name: string }[] }
type Sortable = { name: string; size?: number; created_at?: string; updated_at?: string }
const SORTS = {
  name: 'Name (A to Z)',
  '-name': 'Name (Z to A)',
  '-updated': 'Last modified (newest)',
  updated: 'Last modified (oldest)',
  '-size': 'Size (largest)',
  size: 'Size (smallest)',
} as const
export type SortKey = keyof typeof SORTS
const byName = (a: Sortable, b: Sortable) =>
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
const stamp = (x: Sortable) => Date.parse(x.updated_at ?? x.created_at ?? '') || 0
/** A copy of items in key's order, ties broken by name. Folders have no size: they keep name order. */
export function sortItems<T extends Sortable>(items: T[], key: SortKey): T[] {
  const field = key.replace('-', '')
  const dir = key.startsWith('-') ? -1 : 1
  const cmp = (a: T, b: T) =>
    field === 'size'
      ? (a.size ?? 0) - (b.size ?? 0)
      : field === 'updated'
        ? stamp(a) - stamp(b)
        : byName(a, b)
  return [...items].sort((a, b) => dir * cmp(a, b) || byName(a, b))
}

// A row dragged inside the pane (to move it) carries this type; files from the desktop carry 'Files'.
const ITEM = 'application/x-eerp-team-item'

type Action = {
  label: string
  icon: IconDefinition
  onClick?: () => void
  href?: string
  danger?: boolean
}

/** Icon buttons on a wide screen; one ⋮ menu when narrow (phone or the conversation's side panel). */
function Actions({ actions, menu, label }: { actions: Action[]; menu: boolean; label: string }) {
  const t = useT()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  if (!actions.length) return null
  const link = (a: Action) =>
    (a.href ? { component: 'a', href: a.href, download: true } : {}) as object
  if (menu)
    return (
      <>
        <IconButton
          size="small"
          aria-label={`${t('More actions')} ${label}`.trim()}
          onClick={(e) => setAnchor(e.currentTarget)}
        >
          <FontAwesomeIcon icon={faEllipsisVertical} />
        </IconButton>
        <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)}>
          {actions.map((a) => (
            <MenuItem
              key={a.label}
              {...link(a)}
              onClick={() => {
                setAnchor(null)
                a.onClick?.()
              }}
              sx={a.danger ? { color: 'error.main' } : undefined}
            >
              <FontAwesomeIcon icon={a.icon} fixedWidth style={{ marginRight: 8 }} />
              {a.label}
            </MenuItem>
          ))}
        </Menu>
      </>
    )
  return (
    <Stack direction="row" spacing={0.5} sx={{ justifyContent: 'flex-end' }}>
      {actions.map((a) => (
        <Tooltip key={a.label} title={a.label}>
          <IconButton
            size="small"
            aria-label={a.label}
            color={a.danger ? 'error' : 'default'}
            {...link(a)}
            onClick={a.onClick}
          >
            <FontAwesomeIcon icon={a.icon} size="sm" />
          </IconButton>
        </Tooltip>
      ))}
    </Stack>
  )
}

type Dlg =
  | { kind: 'newFolder' }
  | { kind: 'newDocument' }
  | { kind: 'rename'; target: 'file' | 'folder'; id: string; name: string }
  | { kind: 'delete'; target: 'file' | 'folder'; id: string; name: string }
  | { kind: 'move'; target: 'file' | 'folder'; id: string }
  | { kind: 'share'; id: string }

/** The team's file manager: a folder listing with upload, rename, move, share and delete.
 * With rootFolderId it browses below that folder only, in place (no URL change): a conversation's folder panel. */
export function FilesPane({
  teamId,
  folderId: urlFolder,
  rootFolderId,
  compact = false,
  role,
  onFoldersChanged,
  onFolderName,
}: {
  teamId: string
  folderId?: string
  rootFolderId?: string
  compact?: boolean
  role?: Role
  onFoldersChanged?: () => void
  onFolderName?: (name: string | null) => void
}) {
  const t = useT()
  const [inPanel, setInPanel] = useState<string | undefined>()
  const folderId = rootFolderId ? (inPanel ?? rootFolderId) : urlFolder
  const me = useSessionStore((s) => s.identity?.userId)
  const [listing, setListing] = useState<FolderListing | null>(null)
  const [missing, setMissing] = useState(false)
  const [gone, setGone] = useState(false)
  const [error, setError] = useState('')
  const [dlg, setDlg] = useState<Dlg | null>(null)
  const [name, setName] = useState('')
  const [newDocument, setNewDocument] = useState<{ id: string; name: string } | null>(null)
  const [documentKind, setDocumentKind] = useState('docx')
  const input = useRef<HTMLInputElement>(null)
  const phone = useMediaQuery(useTheme().breakpoints.down('sm'))
  const narrow = compact || phone
  // The folder a drag hovers ('' = the root, undefined = none): highlighted as the drop target.
  const [over, setOver] = useState<string | undefined>()
  const [sort, setSort] = useState<SortKey>('name')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<FileSearch | null>(null)
  // Bumped after each change, so open search results refresh too.
  const [changes, setChanges] = useState(0)
  useEffect(() => setQuery(''), [folderId])
  const searching = query.trim() !== ''
  useEffect(() => {
    const text = query.trim()
    if (!text) return setResults(null)
    let live = true
    const timer = setTimeout(() => {
      searchFiles(teamId, text)
        .then((r) => live && setResults(r))
        .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)))
    }, 300)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [teamId, query, changes])

  const reload = useCallback(() => {
    listFiles(teamId, folderId)
      .then((l) => {
        setListing(l)
        setMissing(false)
        setGone(false)
      })
      .catch((e: unknown) => {
        const { status, code } = e as { status?: number; code?: string }
        // Go mounts the files routes only when S3 is configured: an unmounted route's 404 has no Go error code.
        if (status === 404 && !code) setMissing(true)
        else if (status === 404) setGone(true)
        else setError(e instanceof Error ? e.message : t('The change could not be saved.'))
      })
  }, [teamId, folderId, t])
  useEffect(reload, [reload])
  const folderName = folderId ? (listing?.folder?.name ?? null) : null
  useEffect(() => onFolderName?.(folderName), [folderName, onFolderName])

  const [busy, setBusy] = useState(false)
  const run = (p: Promise<unknown>, folders = false) => {
    setError('')
    setBusy(true)
    p.then(() => {
      setDlg(null)
      reload()
      setChanges((n) => n + 1)
      if (folders) onFoldersChanged?.()
    })
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : t('The change could not be saved.')),
      )
      .finally(() => setBusy(false))
  }
  const canEdit = (owner: string) => role === 'owner' || (role === 'member' && owner === me)
  const canWrite = role === 'owner' || role === 'member'

  const upload = (files: File[], into?: string) => {
    if (files.length) run(Promise.all(files.map((f) => uploadFile(teamId, f, into || undefined))))
  }
  const move = (kind: 'file' | 'folder', id: string, to: string) =>
    run(
      kind === 'file'
        ? updateFile(teamId, id, { folder_id: to })
        : updateFolder(teamId, id, { parent_id: to }),
      kind === 'folder',
    )
  // Desktop files dropped on a folder are uploaded into it; a row dropped on a folder moves there.
  const dropOn = (target: string) => ({
    onDragOver: (e: DragEvent) => {
      const types = e.dataTransfer.types
      if (!canWrite || !(types.includes('Files') || types.includes(ITEM))) return
      e.preventDefault()
      e.stopPropagation()
      setOver(target)
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(undefined)
    },
    onDrop: (e: DragEvent) => {
      setOver(undefined)
      if (!canWrite) return
      e.preventDefault()
      e.stopPropagation()
      const item = e.dataTransfer.getData(ITEM)
      if (item) {
        const { kind, id } = JSON.parse(item) as { kind: 'file' | 'folder'; id: string }
        if (id !== target) move(kind, id, target)
      } else upload(Array.from(e.dataTransfer.files ?? []), target)
    },
  })
  const dragItem = (kind: 'file' | 'folder', id: string, owner: string) =>
    canEdit(owner)
      ? {
          draggable: true,
          onDragStart: (e: DragEvent) => {
            e.dataTransfer.setData(ITEM, JSON.stringify({ kind, id }))
            e.dataTransfer.effectAllowed = 'move'
          },
        }
      : {}
  const highlight = (target: string) => (over === target ? { bgcolor: 'action.hover' } : undefined)

  if (missing)
    return (
      <Typography color="text.secondary" sx={{ p: 3 }} data-testid="teams-files-pane">
        <T text="File storage is not configured." />
      </Typography>
    )
  if (gone) {
    return (
      <Box sx={{ p: 3 }} data-testid="teams-files-pane">
        <Typography color="text.secondary">
          <T text="This folder no longer exists." />
        </Typography>
        {rootFolderId ? (
          inPanel && (
            <Link component="button" onClick={() => setInPanel(undefined)} underline="hover">
              <T text="Back" />
            </Link>
          )
        ) : (
          <Link component={IntentLink} href={erpPath(`/teams/${teamId}/files`)} underline="hover">
            <T text="All files" />
          </Link>
        )}
      </Box>
    )
  }

  const submitName = () => {
    // busy: a double click must not create the folder twice.
    if (!dlg || !name.trim() || busy) return
    if (dlg.kind === 'newFolder') run(createFolder(teamId, name.trim(), folderId), true)
    else if (dlg.kind === 'newDocument')
      run(
        createDocument(teamId, name.trim(), documentKind, folderId).then((file) =>
          setNewDocument(file),
        ),
      )
    else if (dlg.kind === 'rename')
      run(
        dlg.target === 'file'
          ? updateFile(teamId, dlg.id, { name: name.trim() })
          : updateFolder(teamId, dlg.id, { name: name.trim() }),
        dlg.target === 'folder',
      )
  }
  const openName = (d: Dlg, initial = '') => {
    setError('')
    setName(initial)
    setDlg(d)
  }

  const folderLink = (id: string, label: string) =>
    rootFolderId ? (
      <Link
        key={id}
        component="button"
        onClick={() => setInPanel(id)}
        underline="hover"
        sx={{ verticalAlign: 'baseline' }}
      >
        {label}
      </Link>
    ) : (
      <Link
        key={id}
        component={IntentLink}
        href={erpPath(`/teams/${teamId}/files?folder=${id}`)}
        underline="hover"
      >
        {label}
      </Link>
    )
  // Rooted: the crumbs above the root are hidden, even when the viewer could see them.
  const crumbs = rootFolderId
    ? listing?.path.slice(
        Math.max(
          0,
          listing.path.findIndex((p) => p.id === rootFolderId),
        ),
      )
    : listing?.path

  // The office viewer's Share button, for those who may share the file.
  const shareButton = (id: string, owner: string) =>
    canEdit(owner) ? (
      <Tooltip title={t('Share')}>
        <IconButton aria-label={t('Share')} onClick={() => setDlg({ kind: 'share', id })}>
          <FontAwesomeIcon icon={faShareNodes} />
        </IconButton>
      </Tooltip>
    ) : undefined
  const actions = (kind: 'file' | 'folder', id: string, label: string, owner: string): Action[] => [
    ...(kind === 'file'
      ? [{ label: t('Download'), icon: faDownload, href: `/api/teams/files/${id}/download` }]
      : []),
    ...(canEdit(owner)
      ? [
          ...(kind === 'file'
            ? [
                {
                  label: t('Share'),
                  icon: faShareNodes,
                  onClick: () => setDlg({ kind: 'share', id }),
                },
              ]
            : []),
          {
            label: t('Move'),
            icon: faArrowsUpDownLeftRight,
            onClick: () => setDlg({ kind: 'move', target: kind, id }),
          },
          {
            label: t('Rename'),
            icon: faPen,
            onClick: () => openName({ kind: 'rename', target: kind, id, name: label }, label),
          },
          {
            label: t('Delete'),
            icon: faTrash,
            danger: true,
            onClick: () => setDlg({ kind: 'delete', target: kind, id, name: label }),
          },
        ]
      : []),
  ]
  const toolbar: Action[] = canWrite
    ? [
        {
          label: t('New document'),
          icon: faFileCirclePlus,
          onClick: () => openName({ kind: 'newDocument' }),
        },
        {
          label: t('New folder'),
          icon: faFolderPlus,
          onClick: () => openName({ kind: 'newFolder' }),
        },
        { label: t('Upload'), icon: faUpload, onClick: () => input.current?.click() },
      ]
    : []
  const cell = (node: ReactNode) => (narrow ? null : <TableCell>{node}</TableCell>)
  // Rooted (a conversation's panel): only hits below the root.
  const inRoot = (path: { id: string }[], id?: string) =>
    !rootFolderId || id === rootFolderId || path.some((p) => p.id === rootFolderId)
  const shownFolders: (Folder & Hit)[] = sortItems(
    searching
      ? (results?.folders.filter((f) => inRoot(f.path, f.id)) ?? [])
      : (listing?.folders ?? []),
    sort,
  )
  const shownFiles: (TeamFile & Hit)[] = sortItems(
    searching ? (results?.files.filter((f) => inRoot(f.path)) ?? []) : (listing?.files ?? []),
    sort,
  )
  const where = (path?: { name: string }[]) =>
    searching && path ? (
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
        {path.length ? path.map((p) => p.name).join(' / ') : t('All files')}
      </Typography>
    ) : null
  const named = (icon: ReactNode, link: ReactNode, path?: { name: string }[]) => (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
      {icon}
      <Box sx={{ minWidth: 0 }}>
        {link}
        {where(path)}
      </Box>
    </Stack>
  )

  return (
    <Box
      data-testid="teams-files-pane"
      {...dropOn(folderId ?? '')}
      sx={{ p: compact ? 1 : 2, overflow: 'auto', height: '100%' }}
    >
      <Stack
        direction="row"
        sx={{
          alignItems: 'center',
          justifyContent: 'space-between',
          mb: 1,
          flexWrap: 'wrap',
          gap: 1,
        }}
      >
        <Breadcrumbs aria-label={t('Path')}>
          {!rootFolderId && (
            <Box component="span" {...dropOn('')} sx={highlight('')}>
              <Link
                component={IntentLink}
                href={erpPath(`/teams/${teamId}/files`)}
                underline="hover"
              >
                <T text="All files" />
              </Link>
            </Box>
          )}
          {crumbs?.map((p) => (
            <Box key={p.id} component="span" {...dropOn(p.id)} sx={highlight(p.id)}>
              {folderLink(p.id, p.name)}
            </Box>
          ))}
        </Breadcrumbs>
        {canWrite && (
          <Stack direction="row" spacing={1}>
            <Actions actions={toolbar} menu={narrow} label="" />
            <input
              ref={input}
              type="file"
              multiple
              hidden
              data-testid="teams-upload-input"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? [])
                e.target.value = ''
                upload(files, folderId)
              }}
            />
          </Stack>
        )}
      </Stack>
      <Stack direction="row" spacing={1} sx={{ mb: 1, flexWrap: 'wrap', gap: 1 }}>
        <TextField
          size="small"
          type="search"
          placeholder={t('Search all files')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          sx={{ flex: 1, minWidth: 160 }}
          slotProps={{
            htmlInput: { 'aria-label': t('Search all files') },
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <FontAwesomeIcon icon={faMagnifyingGlass} />
                </InputAdornment>
              ),
            },
          }}
        />
        <TextField
          select
          size="small"
          label={t('Sort by')}
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          sx={{ minWidth: 180 }}
        >
          {Object.entries(SORTS).map(([k, label]) => (
            <MenuItem key={k} value={k}>
              {t(label)}
            </MenuItem>
          ))}
        </TextField>
      </Stack>
      {error && (
        <Alert severity="error" sx={{ mb: 1 }}>
          {error}
        </Alert>
      )}
      {searching && results && !shownFolders.length && !shownFiles.length && (
        <Typography color="text.secondary" sx={{ p: 1 }}>
          <T text="No files found." />
        </Typography>
      )}
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>
              <T text="Name" />
            </TableCell>
            {cell(<T text="Size" />)}
            {cell(<T text="Uploaded by" />)}
            {cell(<T text="Created" />)}
            {cell(<T text="Last modified" />)}
            <TableCell />
          </TableRow>
        </TableHead>
        <TableBody>
          {shownFolders.map((f) => (
            <TableRow
              key={f.id}
              {...dragItem('folder', f.id, f.created_by)}
              {...dropOn(f.id)}
              sx={highlight(f.id)}
            >
              <TableCell>
                {named(<FileIcon name={f.name} folder />, folderLink(f.id, f.name), f.path)}
              </TableCell>
              {cell(null)}
              {cell(null)}
              {cell(when(f.created_at))}
              {cell(when(f.updated_at))}
              <TableCell align="right">
                <Actions
                  actions={actions('folder', f.id, f.name, f.created_by)}
                  menu={narrow}
                  label={f.name}
                />
              </TableCell>
            </TableRow>
          ))}
          {shownFiles.map((f) => (
            <TableRow key={f.id} {...dragItem('file', f.id, f.uploaded_by)}>
              <TableCell>
                {named(
                  <FileIcon name={f.name} />,
                  <OfficeFileLink
                    name={f.name}
                    url={`/api/teams/files/${f.id}/download`}
                    source={{ kind: 'team-file', id: f.id }}
                    onClosed={reload}
                    headerActions={shareButton(f.id, f.uploaded_by)}
                  />,
                  f.path,
                )}
              </TableCell>
              {cell(formatSize(f.size))}
              {cell(f.uploaded_by_name)}
              {cell(when(f.created_at))}
              {cell(when(f.updated_at))}
              <TableCell align="right">
                <Actions
                  actions={actions('file', f.id, f.name, f.uploaded_by)}
                  menu={narrow}
                  label={f.name}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {newDocument && (
        <OfficeDialog
          name={newDocument.name}
          url={`/api/teams/files/${newDocument.id}/download`}
          source={{ kind: 'team-file', id: newDocument.id }}
          headerActions={shareButton(newDocument.id, me ?? '')}
          onClose={() => {
            setNewDocument(null)
            reload()
          }}
        />
      )}
      <Dialog
        open={dlg?.kind === 'newFolder' || dlg?.kind === 'newDocument' || dlg?.kind === 'rename'}
        onClose={() => setDlg(null)}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>
          {dlg?.kind === 'rename' ? (
            <T text="Rename" />
          ) : dlg?.kind === 'newDocument' ? (
            <T text="New document" />
          ) : (
            <T text="New folder" />
          )}
        </DialogTitle>
        <DialogContent>
          {error && (
            <Alert severity="error" sx={{ mb: 1 }}>
              {error}
            </Alert>
          )}
          {dlg?.kind === 'newDocument' && (
            <TextField
              select
              fullWidth
              size="small"
              label={t('Document type')}
              value={documentKind}
              onChange={(e) => setDocumentKind(e.target.value)}
              sx={{ mt: 1, mb: 1 }}
            >
              <MenuItem value="docx">{t('Document')} (.docx)</MenuItem>
              <MenuItem value="xlsx">{t('Spreadsheet')} (.xlsx)</MenuItem>
              <MenuItem value="pptx">{t('Presentation')} (.pptx)</MenuItem>
            </TextField>
          )}
          <TextField
            autoFocus
            fullWidth
            size="small"
            sx={{ mt: 1 }}
            label={t('Name')}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDlg(null)}>
            <T text="Cancel" />
          </Button>
          <Button variant="contained" disabled={!name.trim() || busy} onClick={submitName}>
            <T text="Save" />
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={dlg?.kind === 'delete'} onClose={() => setDlg(null)}>
        <DialogTitle>
          <T text="Delete" />
        </DialogTitle>
        <DialogContent>
          <Typography>
            <T text="This cannot be undone." /> {dlg?.kind === 'delete' ? dlg.name : ''}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDlg(null)}>
            <T text="Cancel" />
          </Button>
          <Button
            color="error"
            variant="contained"
            disabled={busy}
            onClick={() => {
              if (dlg?.kind === 'delete')
                run(
                  dlg.target === 'file' ? deleteFile(teamId, dlg.id) : deleteFolder(teamId, dlg.id),
                  dlg.target === 'folder',
                )
            }}
          >
            <T text="Delete" />
          </Button>
        </DialogActions>
      </Dialog>

      <FolderPicker
        open={dlg?.kind === 'move'}
        teamId={teamId}
        moveError={dlg?.kind === 'move' ? error : undefined}
        exclude={dlg?.kind === 'move' && dlg.target === 'folder' ? dlg.id : undefined}
        onClose={() => setDlg(null)}
        onPick={(folder) => {
          if (dlg?.kind === 'move') move(dlg.target, dlg.id, folder)
        }}
      />
      <ShareDialog
        open={dlg?.kind === 'share'}
        fileId={dlg?.kind === 'share' ? dlg.id : ''}
        onClose={() => setDlg(null)}
        onSaved={reload}
      />
    </Box>
  )
}
