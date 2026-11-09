'use client'
import { useState } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Typography from '@mui/material/Typography'
import { T } from '@eerp/core-front'
import { linkFolder, type Role } from './client'
import { FilesPane } from './FilesPane'
import { FolderPicker } from './FolderPicker'

/** The right panel of a team conversation: its linked folder, or a way to link one. */
export function FolderPanel({ teamId, channelId, folderId, role, onLinked, onFoldersChanged }: { teamId: string; channelId: string; folderId?: string | null; role?: Role; onLinked: () => void; onFoldersChanged?: () => void }) {
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState('')

  if (folderId) return <FilesPane teamId={teamId} rootFolderId={folderId} role={role} compact onFoldersChanged={onFoldersChanged} />

  const link = (folder: string) => {
    setError('')
    linkFolder(teamId, channelId, folder)
      .then(() => { setPicking(false); onLinked() })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : ''))
  }
  return (
    <Box sx={{ p: 2 }}>
      {role === 'owner' ? (
        <Button variant="outlined" onClick={() => { setError(''); setPicking(true) }}><T text="Link a folder" /></Button>
      ) : (
        <Typography color="text.secondary"><T text="No folder yet. Files sent here will create one." /></Typography>
      )}
      <FolderPicker open={picking} teamId={teamId} allowRoot={false} moveError={error} onPick={link} onClose={() => setPicking(false)}
        title={<T text="Link a folder" />} confirm={<T text="Link this folder" />} />
    </Box>
  )
}
