'use client'
import { useEffect, useState } from 'react'
import Box from '@mui/material/Box'
import Link from '@mui/material/Link'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import Typography from '@mui/material/Typography'
import { T } from '@eerp/core-front'
import { listShared, type SharedFile } from './client'
import { formatSize } from './FilesPane'

/** Files other people shared with me, across every team. */
export function SharedPane() {
  const [files, setFiles] = useState<SharedFile[] | null>(null)
  useEffect(() => {
    listShared().then(setFiles).catch(() => setFiles([]))
  }, [])
  return (
    <Box data-testid="teams-shared-pane" sx={{ p: 2, overflow: 'auto', height: '100%' }}>
      <Typography variant="h6" component="h2" sx={{ mb: 1 }}><T text="Shared with me" /></Typography>
      {files?.length === 0 && <Typography color="text.secondary"><T text="Nothing has been shared with you yet." /></Typography>}
      {files && files.length > 0 && (
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell><T text="Name" /></TableCell>
              <TableCell><T text="Team" /></TableCell>
              <TableCell><T text="Shared by" /></TableCell>
              <TableCell><T text="Size" /></TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {files.map((f) => (
              <TableRow key={f.id}>
                <TableCell><Link href={`/api/teams/files/${f.id}/download`}>{f.name}</Link></TableCell>
                <TableCell>{f.team_name}</TableCell>
                <TableCell>{f.shared_by_name}</TableCell>
                <TableCell>{formatSize(f.size)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Box>
  )
}
