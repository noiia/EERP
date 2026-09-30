'use client'
import { useState } from 'react'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import TextField from '@mui/material/TextField'
import { useT } from '@eerp/core-front'
import { listOutbox, retryOutbox, type OutboxMail, type OutboxStatus } from '@/lib/website-settings'

const COLORS = { pending: 'default', sent: 'success', failed: 'error' } as const

export default function OutboxTable({ initial }: { initial: OutboxMail[] }) {
  const t = useT()
  const [mails, setMails] = useState(initial)
  const [status, setStatus] = useState<OutboxStatus | ''>('')
  const [error, setError] = useState<string | null>(null)

  async function load(s: OutboxStatus | '') {
    setStatus(s)
    setMails(await listOutbox(s || undefined))
  }

  async function retry(id: string) {
    setError(null)
    const res = await retryOutbox(id)
    if (!res.ok) setError(res.message || t('Could not retry.'))
    await load(status)
  }

  return (
    <Stack spacing={2}>
      {error && <Alert severity="error">{error}</Alert>}
      <TextField
        select
        size="small"
        label={t('Status')}
        value={status}
        onChange={(e) => void load(e.target.value as OutboxStatus | '')}
        sx={{ maxWidth: 200 }}
      >
        <MenuItem value="">{t('All')}</MenuItem>
        <MenuItem value="pending">{t('pending')}</MenuItem>
        <MenuItem value="sent">{t('sent')}</MenuItem>
        <MenuItem value="failed">{t('failed')}</MenuItem>
      </TextField>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>{t('Recipient')}</TableCell>
            <TableCell>{t('Subject')}</TableCell>
            <TableCell>{t('Status')}</TableCell>
            <TableCell>{t('Attempts')}</TableCell>
            <TableCell>{t('Last error')}</TableCell>
            <TableCell>{t('Created')}</TableCell>
            <TableCell />
          </TableRow>
        </TableHead>
        <TableBody>
          {mails.map((m) => (
            <TableRow key={m.id}>
              <TableCell>{m.to_address}</TableCell>
              <TableCell>{m.subject}</TableCell>
              <TableCell>
                <Chip size="small" label={t(m.status)} color={COLORS[m.status]} />
              </TableCell>
              <TableCell>{m.attempts}</TableCell>
              <TableCell sx={{ maxWidth: 320, overflowWrap: 'anywhere' }}>{m.last_error}</TableCell>
              <TableCell>{new Date(m.created_at).toLocaleString()}</TableCell>
              <TableCell>
                {m.status === 'failed' && (
                  <Button size="small" onClick={() => void retry(m.id)}>
                    {t('Retry')}
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Stack>
  )
}
