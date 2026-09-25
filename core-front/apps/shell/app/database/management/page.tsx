'use client'
import { useCallback, useEffect, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Container from '@mui/material/Container'
import Divider from '@mui/material/Divider'
import Paper from '@mui/material/Paper'
import Stack from '@mui/material/Stack'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'

// /database/management — an Odoo-style database manager, reachable with NO
// login at all (core/CLAUDE.md's "Database management" bullet). Deliberately
// OUTSIDE requireAuth()/the descriptor-driven view engine, modeled on the
// hand-built Settings pages (Formats/Account) rather than EntityView — this
// route must render for a fully anonymous visitor. No BFF/Server Actions:
// every call goes straight to core-back (same origin, nginx already proxies
// /api/v1/*), carrying the master key from the field below as an
// X-Master-Key header — the same "browser calls Go directly for a good
// reason" precedent Presence already established (core-front/CLAUDE.md), the
// reason here being the same class: large binary transfer (dump/restore)
// with no session/cookie involved at all.

type PrepareStatus = 'unprepared' | 'preparing' | 'ready' | 'failed'

interface DatabaseInfo {
  name: string
  size_bytes: number
  active: boolean
  status: PrepareStatus
  prepare_error?: string
}

const API_BASE = '/api/v1/database-management'
// How often to re-poll the list while any row is still "preparing" — there's
// no push/webhook path here, and Prepare itself runs off-request in a
// goroutine (docs/adr/ADR-021-database-management.md's Prepare/Activate
// split), so polling is the only way this page learns it finished.
const PREPARING_POLL_MS = 3000

function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let n = bytes
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i += 1
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

async function readErrorMessage(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null
  return body?.error?.message ?? `Request failed (${res.status}).`
}

export default function DatabaseManagementPage() {
  const [masterKey, setMasterKey] = useState('')
  const [databases, setDatabases] = useState<DatabaseInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [createName, setCreateName] = useState('')
  const [restoreName, setRestoreName] = useState('')
  const [restoreFile, setRestoreFile] = useState<File | null>(null)

  const headers = useCallback(() => ({ 'X-Master-Key': masterKey }), [masterKey])

  const loadDatabases = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      if (!silent) {
        setError(null)
        setBusy(true)
      }
      try {
        const res = await fetch(`${API_BASE}/databases`, { headers: headers() })
        if (!res.ok) throw new Error(await readErrorMessage(res))
        setDatabases((await res.json()) as DatabaseInfo[])
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not load databases.')
      } finally {
        if (!silent) setBusy(false)
      }
    },
    [headers],
  )

  // While anything is "preparing", keep polling quietly in the background —
  // a silent refresh (no busy flag, no error-clearing) so it never fights
  // with an in-flight foreground action's own withBusy.
  useEffect(() => {
    if (!databases?.some((db) => db.status === 'preparing')) return
    const id = setInterval(() => void loadDatabases({ silent: true }), PREPARING_POLL_MS)
    return () => clearInterval(id)
  }, [databases, loadDatabases])

  async function withBusy(action: () => Promise<void>) {
    setError(null)
    setNotice(null)
    setBusy(true)
    try {
      await action()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed.')
    } finally {
      setBusy(false)
    }
  }

  function handleCreate() {
    void withBusy(async () => {
      const res = await fetch(`${API_BASE}/databases`, {
        method: 'POST',
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: createName }),
      })
      if (!res.ok) throw new Error(await readErrorMessage(res))
      setCreateName('')
      setNotice(`Database "${createName}" created and initialized — ready to activate.`)
      await loadDatabases()
    })
  }

  function handlePrepare(name: string) {
    void withBusy(async () => {
      const res = await fetch(`${API_BASE}/databases/${encodeURIComponent(name)}/prepare`, {
        method: 'POST',
        headers: headers(),
      })
      if (!res.ok) throw new Error(await readErrorMessage(res))
      setNotice(`Preparing "${name}" in the background — this page will update once it's ready to activate.`)
      await loadDatabases()
    })
  }

  function handleActivate(name: string) {
    void withBusy(async () => {
      const res = await fetch(`${API_BASE}/databases/${encodeURIComponent(name)}/activate`, {
        method: 'POST',
        headers: headers(),
      })
      if (!res.ok) throw new Error(await readErrorMessage(res))
      setNotice(
        `Activated "${name}". Every session logged into the main app (including this browser's, if any) has just been invalidated — that's expected, not a bug.`,
      )
      await loadDatabases()
    })
  }

  function handleDiscard(name: string) {
    void withBusy(async () => {
      const res = await fetch(`${API_BASE}/databases/${encodeURIComponent(name)}/prepare`, {
        method: 'DELETE',
        headers: headers(),
      })
      if (!res.ok && res.status !== 204) throw new Error(await readErrorMessage(res))
      setNotice(`Discarded the prepared standby for "${name}".`)
      await loadDatabases()
    })
  }

  function handleDelete(name: string) {
    if (!window.confirm(`Permanently delete database "${name}"? This cannot be undone.`)) return
    void withBusy(async () => {
      const res = await fetch(`${API_BASE}/databases/${encodeURIComponent(name)}`, {
        method: 'DELETE',
        headers: headers(),
      })
      if (!res.ok && res.status !== 204) throw new Error(await readErrorMessage(res))
      setNotice(`Database "${name}" deleted.`)
      await loadDatabases()
    })
  }

  function handleExtract(name: string, includeS3: boolean) {
    void withBusy(async () => {
      const res = await fetch(
        `${API_BASE}/databases/${encodeURIComponent(name)}/extract?include_s3=${includeS3}`,
        { headers: headers() },
      )
      if (!res.ok) throw new Error(await readErrorMessage(res))
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${name}.zip`
      a.click()
      URL.revokeObjectURL(url)
    })
  }

  function handleRestore() {
    if (!restoreFile) {
      setError('Pick a .zip file to restore first.')
      return
    }
    void withBusy(async () => {
      const form = new FormData()
      form.set('name', restoreName)
      form.set('file', restoreFile)
      const res = await fetch(`${API_BASE}/databases/restore`, {
        method: 'POST',
        headers: headers(),
        body: form,
      })
      if (!res.ok) throw new Error(await readErrorMessage(res))
      setRestoreName('')
      setRestoreFile(null)
      setNotice(`Restored into "${restoreName}". Prepare it, then activate separately when ready.`)
      await loadDatabases()
    })
  }

  return (
    <Container maxWidth="md" sx={{ py: 8 }}>
      <Stack spacing={3}>
        <Typography variant="h5" component="h1">
          Database management
        </Typography>

        <TextField
          label="Master key"
          type="password"
          value={masterKey}
          onChange={(e) => setMasterKey(e.target.value)}
          helperText="Required to authenticate every action below."
          fullWidth
        />

        {error ? <Alert severity="error">{error}</Alert> : null}
        {notice ? <Alert severity="success">{notice}</Alert> : null}

        <Box>
          <Button variant="outlined" onClick={() => void loadDatabases()} disabled={busy || !masterKey}>
            Load databases
          </Button>
        </Box>

        {databases ? (
          <Paper variant="outlined">
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Name</TableCell>
                  <TableCell>Size</TableCell>
                  <TableCell align="right">Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {databases.map((db) => (
                  <TableRow key={db.name}>
                    <TableCell>
                      {db.name}
                      {db.active ? <Chip size="small" color="primary" label="active" sx={{ ml: 1 }} /> : null}
                      {!db.active && db.status === 'ready' ? (
                        <Chip size="small" color="success" variant="outlined" label="ready to activate" sx={{ ml: 1 }} />
                      ) : null}
                      {db.status === 'preparing' ? (
                        <Chip
                          size="small"
                          variant="outlined"
                          icon={<CircularProgress size={12} />}
                          label="preparing…"
                          sx={{ ml: 1 }}
                        />
                      ) : null}
                      {db.status === 'failed' ? (
                        <Chip
                          size="small"
                          color="error"
                          variant="outlined"
                          label={db.prepare_error ? `prepare failed: ${db.prepare_error}` : 'prepare failed'}
                          sx={{ ml: 1, maxWidth: 320 }}
                        />
                      ) : null}
                    </TableCell>
                    <TableCell>{formatSize(db.size_bytes)}</TableCell>
                    <TableCell align="right">
                      <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end' }}>
                        {!db.active && (db.status === 'unprepared' || db.status === 'failed') ? (
                          <Button size="small" disabled={busy} onClick={() => handlePrepare(db.name)}>
                            Prepare
                          </Button>
                        ) : null}
                        {!db.active && db.status === 'ready' ? (
                          <>
                            <Button size="small" variant="contained" disabled={busy} onClick={() => handleActivate(db.name)}>
                              Activate
                            </Button>
                            <Button size="small" disabled={busy} onClick={() => handleDiscard(db.name)}>
                              Discard
                            </Button>
                          </>
                        ) : null}
                        <Button size="small" disabled={busy} onClick={() => handleExtract(db.name, false)}>
                          Extract (SQL)
                        </Button>
                        <Button size="small" disabled={busy} onClick={() => handleExtract(db.name, true)}>
                          Extract (SQL+S3)
                        </Button>
                        <Button
                          size="small"
                          color="error"
                          disabled={busy || db.active}
                          onClick={() => handleDelete(db.name)}
                        >
                          Delete
                        </Button>
                      </Stack>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Paper>
        ) : null}

        <Divider />

        <Typography variant="h6">Create empty database</Typography>
        <Stack direction="row" spacing={2}>
          <TextField
            label="Name"
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            helperText="lowercase, letters/digits/underscore"
            size="small"
          />
          <Button variant="contained" disabled={busy || !masterKey || !createName} onClick={handleCreate}>
            Create
          </Button>
        </Stack>

        <Divider />

        <Typography variant="h6">Restore from a zip</Typography>
        <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
          <TextField
            label="New database name"
            value={restoreName}
            onChange={(e) => setRestoreName(e.target.value)}
            size="small"
          />
          <Button component="label" variant="outlined" size="small">
            {restoreFile ? restoreFile.name : 'Choose .zip'}
            <input
              type="file"
              accept=".zip"
              hidden
              onChange={(e) => setRestoreFile(e.target.files?.[0] ?? null)}
            />
          </Button>
          <Button
            variant="contained"
            disabled={busy || !masterKey || !restoreName || !restoreFile}
            onClick={handleRestore}
          >
            Restore
          </Button>
        </Stack>
        <Typography variant="body2" color="text.secondary">
          Generated report PDFs are never included in an S3 extraction — they have no durable record
          of their storage key and are always regeneratable from the underlying invoice/quote/receipt
          data, which the SQL dump already carries.
        </Typography>
      </Stack>
    </Container>
  )
}
