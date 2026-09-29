'use client'
import { useState } from 'react'
import Alert from '@mui/material/Alert'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import TextField from '@mui/material/TextField'
import { useT } from '@eerp/core-front'
import { updateWebsiteUser, type WebsiteUser } from '@/lib/website-settings'

export default function WebsiteUsersTable({ initial }: { initial: WebsiteUser[] }) {
  const t = useT()
  const [users, setUsers] = useState(initial)
  const [error, setError] = useState<string | null>(null)

  async function patch(id: string, p: Parameters<typeof updateWebsiteUser>[1]) {
    setError(null)
    const res = await updateWebsiteUser(id, p)
    if (!res.ok) setError(res.message || t('Could not save.'))
    else setUsers((prev) => prev.map((u) => (u.id === id ? { ...u, ...p } : u)))
  }
  const edit = (id: string, k: 'name' | 'phone', v: string) =>
    setUsers((prev) => prev.map((u) => (u.id === id ? { ...u, [k]: v } : u)))

  return (
    <Stack spacing={2}>
      {error && <Alert severity="error">{error}</Alert>}
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>{t('Email')}</TableCell>
            <TableCell>{t('Name')}</TableCell>
            <TableCell>{t('Phone')}</TableCell>
            <TableCell>{t('Created')}</TableCell>
            <TableCell>{t('Verified')}</TableCell>
            <TableCell>{t('Disabled')}</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {users.map((u) => (
            <TableRow key={u.id}>
              <TableCell>{u.email}</TableCell>
              <TableCell>
                <TextField size="small" variant="standard" value={u.name} onChange={(e) => edit(u.id, 'name', e.target.value)} onBlur={() => void patch(u.id, { name: u.name })} />
              </TableCell>
              <TableCell>
                <TextField size="small" variant="standard" value={u.phone} onChange={(e) => edit(u.id, 'phone', e.target.value)} onBlur={() => void patch(u.id, { phone: u.phone })} />
              </TableCell>
              <TableCell>{new Date(u.created_at).toLocaleDateString()}</TableCell>
              <TableCell>{u.email_verified ? t('Yes') : t('No')}</TableCell>
              <TableCell>
                <Switch checked={u.disabled} onChange={(e) => void patch(u.id, { disabled: e.target.checked })} slotProps={{ input: { 'aria-label': t('Disabled') } }} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Stack>
  )
}
