'use client'
import { useEffect, useRef } from 'react'
import Button from '@mui/material/Button'
import Card from '@mui/material/Card'
import CardContent from '@mui/material/CardContent'
import Typography from '@mui/material/Typography'
import { T } from '@eerp/core-front'

/** Starts the linked file's download once, and keeps a button to download it again. */
export function LinkDownload({ token }: { token: string }) {
  const href = `/api/teams/links/${encodeURIComponent(token)}/download`
  const link = useRef<HTMLAnchorElement>(null)
  useEffect(() => link.current?.click(), [])
  return (
    <Card sx={{ maxWidth: 480, mx: 'auto', mt: 6 }}>
      <CardContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          <T text="This link opens one shared file. If it has expired or been revoked, the download answers File not found." />
        </Typography>
        <Button ref={link} variant="contained" component="a" href={href} download>
          <T text="Download file" />
        </Button>
      </CardContent>
    </Card>
  )
}
