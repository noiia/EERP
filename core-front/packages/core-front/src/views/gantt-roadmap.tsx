'use client'
import { forwardRef } from 'react'
import Box from '@mui/material/Box'
import Chip from '@mui/material/Chip'
import Link from '@mui/material/Link'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import Typography from '@mui/material/Typography'
import { useT } from '../i18n/translate'

// Gantt's Roadmap view: every milestone of the pinned scope on one horizontal
// line (its whole span, not the timeline's range), today marked, then the same
// milestones as a table. The wrapper is what the PNG/PDF export captures.

export type RoadmapMilestone = { id: string; name: string; day: Date; reached: boolean }
export type RoadmapStatus = 'reached' | 'late' | 'upcoming'

const DAY_MS = 86_400_000
const LABEL_H = 56
const LINE_H = 24

export function milestoneStatus(m: RoadmapMilestone, today: Date): RoadmapStatus {
  return m.reached ? 'reached' : m.day.getTime() < today.getTime() ? 'late' : 'upcoming'
}

/** Each milestone's left position (0–100 %) over the span of all of them plus today, padded 5 % each side. */
export function roadmapPositions(
  ms: RoadmapMilestone[],
  today: Date,
): { pos: number[]; todayPos: number } {
  const times = [...ms.map((m) => m.day.getTime()), today.getTime()]
  const min = Math.min(...times)
  const max = Math.max(...times)
  const pad = Math.max((max - min) * 0.05, DAY_MS)
  const at = (t: number) => ((t - min + pad) / (max - min + 2 * pad)) * 100
  return { pos: ms.map((m) => at(m.day.getTime())), todayPos: at(today.getTime()) }
}

const COLOR: Record<RoadmapStatus, string> = {
  reached: 'success.main',
  late: 'error.main',
  upcoming: 'primary.main',
}
const LABEL: Record<RoadmapStatus, string> = {
  reached: 'Reached',
  late: 'Late',
  upcoming: 'Upcoming',
}
const CHIP: Record<RoadmapStatus, 'success' | 'error' | 'primary'> = {
  reached: 'success',
  late: 'error',
  upcoming: 'primary',
}

export const GanttRoadmap = forwardRef<
  HTMLDivElement,
  { milestones: RoadmapMilestone[]; onOpen?: (id: string) => void }
>(function GanttRoadmap({ milestones, onOpen }, ref) {
  const t = useT()
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (!milestones.length)
    return (
      <Typography color="text.secondary" sx={{ p: 2 }}>
        {t('No milestones yet.')}
      </Typography>
    )
  const { pos, todayPos } = roadmapPositions(milestones, today)
  const name = (m: RoadmapMilestone) =>
    onOpen ? (
      <Link
        component="button"
        type="button"
        underline="hover"
        onClick={() => onOpen(m.id)}
        sx={{ verticalAlign: 'baseline', textAlign: 'left' }}
      >
        {m.name}
      </Link>
    ) : (
      m.name
    )
  return (
    <Box
      ref={ref}
      data-testid="gantt-roadmap"
      sx={{ bgcolor: 'background.paper', p: 2, overflowX: 'auto' }}
    >
      {/* Labels alternate above and below the line so neighbours don't collide. */}
      <Box
        role="img"
        aria-label={t('Roadmap')}
        sx={{
          position: 'relative',
          height: 2 * LABEL_H + LINE_H,
          minWidth: Math.max(600, milestones.length * 110),
          mx: 8,
        }}
      >
        <Box
          sx={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: LABEL_H + LINE_H / 2 - 2,
            height: 4,
            borderRadius: 2,
            bgcolor: 'divider',
          }}
        />
        <Box
          data-testid="gantt-roadmap-today"
          title={t('Today')}
          sx={{
            position: 'absolute',
            top: LABEL_H - 6,
            height: LINE_H + 12,
            width: 2,
            bgcolor: 'error.main',
            transform: 'translateX(-50%)',
          }}
          style={{ left: `${todayPos}%` }}
        />
        {milestones.map((m, i) => {
          const status = milestoneStatus(m, today)
          const above = i % 2 === 0
          return (
            <Box
              key={m.id}
              sx={{ position: 'absolute', top: 0, bottom: 0, width: 0 }}
              style={{ left: `${pos[i]}%` }}
            >
              <Box
                data-testid={`gantt-roadmap-milestone-${m.id}`}
                sx={{
                  position: 'absolute',
                  top: LABEL_H + LINE_H / 2,
                  width: 16,
                  height: 16,
                  transform: 'translate(-50%, -50%) rotate(45deg)',
                  bgcolor: COLOR[status],
                }}
              />
              <Box
                sx={{
                  position: 'absolute',
                  width: 140,
                  transform: 'translateX(-50%)',
                  textAlign: 'center',
                  ...(above ? { bottom: LABEL_H + LINE_H } : { top: LABEL_H + LINE_H }),
                  py: 0.5,
                }}
                title={`${m.name}: ${m.day.toLocaleDateString()}`}
              >
                <Typography variant="body2" noWrap sx={{ fontWeight: 600 }}>
                  {m.name}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {m.day.toLocaleDateString()}
                </Typography>
              </Box>
            </Box>
          )
        })}
      </Box>
      <Table size="small" sx={{ mt: 2 }}>
        <TableHead>
          <TableRow>
            <TableCell>{t('Milestone')}</TableCell>
            <TableCell>{t('Date')}</TableCell>
            <TableCell>{t('Status')}</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {milestones.map((m) => {
            const status = milestoneStatus(m, today)
            return (
              <TableRow key={m.id}>
                <TableCell>{name(m)}</TableCell>
                <TableCell>{m.day.toLocaleDateString()}</TableCell>
                <TableCell>
                  <Chip
                    size="small"
                    color={CHIP[status]}
                    variant={status === 'upcoming' ? 'outlined' : 'filled'}
                    label={t(LABEL[status])}
                  />
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </Box>
  )
})
