'use client'
import { useEffect, useRef } from 'react'
import Button from '@mui/material/Button'
import Card from '@mui/material/Card'
import CardContent from '@mui/material/CardContent'
import Typography from '@mui/material/Typography'
import { T } from '@eerp/core-front'
import { formatSize } from './FilesPane'

export type LinkInfo = { name: string; size: number }

/** Names the linked file and starts its download once; a dead link (info null) just says so. */
export function LinkDownload({ token, info }: { token: string; info: LinkInfo | null }) {
  const href = `/api/teams/links/${encodeURIComponent(token)}/download`
  const link = useRef<HTMLAnchorElement>(null)
  const started = useRef(false) // StrictMode runs effects twice: one download, one count
  useEffect(() => {
    if (!info || started.current) return
    started.current = true
    link.current?.click()
  }, [info])
  return (
    <Card sx={{ maxWidth: 480, mx: 'auto', mt: 6 }}>
      <CardContent>
        {info ? (
          <>
            <Typography variant="h6" sx={{ overflowWrap: 'anywhere' }}>{info.name}</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>{formatSize(info.size)}</Typography>
            <Button ref={link} variant="contained" component="a" href={href} download>
              <T text="Download file" />
            </Button>
          </>
        ) : (
          <Typography color="text.secondary">
            <T text="This link has expired, been revoked, or does not exist." />
          </Typography>
        )}
      </CardContent>
    </Card>
  )
}
