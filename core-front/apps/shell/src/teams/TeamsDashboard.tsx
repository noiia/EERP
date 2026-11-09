'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Badge from '@mui/material/Badge'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Card from '@mui/material/Card'
import CardActionArea from '@mui/material/CardActionArea'
import Container from '@mui/material/Container'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { erpPath, T, useT } from '@eerp/core-front'
import { listTeams, type Team } from './client'
import { CreateTeamDialog } from './CreateTeamDialog'

function Tile({ href, title, subtitle, unread = 0 }: { href: string; title: string; subtitle?: string; unread?: number }) {
  return (
    <Card variant="outlined">
      <CardActionArea href={erpPath(href)} sx={{ p: 2, minHeight: 100 }}>
        <Stack direction="row" spacing={1} sx={{ justifyContent: "space-between", alignItems: "flex-start" }}>
          <Typography variant="h6" component="span">{title}</Typography>
          {unread > 0 && <Badge badgeContent={unread} color="primary" sx={{ mr: 1.5 }} />}
        </Stack>
        {subtitle && <Typography variant="body2" color="text.secondary">{subtitle}</Typography>}
      </CardActionArea>
    </Card>
  )
}

export function TeamsDashboard() {
  const t = useT()
  const router = useRouter()
  const [teams, setTeams] = useState<Team[]>([])
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    listTeams().then(setTeams).catch(() => setTeams([]))
  }, [])

  return (
    <Container maxWidth={false} sx={{ py: { xs: 2, md: 3 } }}>
      <Stack spacing={2}>
        <Stack direction="row" sx={{ justifyContent: "space-between", alignItems: "center" }}>
          <Typography variant="h4" component="h1" sx={{ fontSize: { xs: '1.5rem', sm: '2.125rem' } }}><T text="Teams" /></Typography>
          <Button variant="contained" onClick={() => setCreating(true)}><T text="Create team" /></Button>
        </Stack>
        <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', md: 'repeat(4, 1fr)' } }}>
          <Tile href="/teams/direct" title={t('Direct messages')} />
          {teams.map((x) => (
            <Tile key={x.id} href={`/teams/${x.id}`} title={x.name} subtitle={String(x.member_count)} unread={x.unread} />
          ))}
        </Box>
      </Stack>
      <CreateTeamDialog open={creating} onClose={() => setCreating(false)} onCreated={(x) => router.push(erpPath(`/teams/${x.id}`))} />
    </Container>
  )
}
