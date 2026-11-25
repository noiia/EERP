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
import { useTheme } from '@mui/material/styles'
import { useT } from '../i18n/translate'
import { useContainerWidth } from './use-container-width'

// Gantt's Roadmap view: every milestone of the pinned scope on one horizontal
// line (its whole span, not the timeline's range), today marked, then the same
// milestones as a table. The wrapper is what the PNG/PDF export captures.

export type RoadmapMilestone = { id: string; name: string; day: Date; reached: boolean }
export type RoadmapStatus = 'reached' | 'late' | 'upcoming'

const DAY_MS = 86_400_000
const LINE_H = 24
const LABEL_W = 140
const LABEL_GAP = 8

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

export type LabelSlot = { above: boolean; level: number; x: number }

/**
 * Where each milestone's label goes on a line `width` px wide, the milestones at `pos` (0–100 %):
 * the first free lane in the order above, below, further above, further below…, so no two
 * labels overlap. A label stays centered on its milestone, pulled inside the line at the ends.
 */
export function roadmapLabelSlots(pos: number[], width: number, labelW = LABEL_W, gap = LABEL_GAP): LabelSlot[] {
  const slots: LabelSlot[] = new Array(pos.length)
  const laneEnds: number[] = [] // lane 2k is above at level k, 2k+1 below
  const order = pos.map((_, i) => i).sort((a, b) => pos[a] - pos[b])
  for (const i of order) {
    const x = Math.min(Math.max((pos[i] / 100) * width, labelW / 2), Math.max(width - labelW / 2, labelW / 2))
    let lane = laneEnds.findIndex((end) => end + gap <= x - labelW / 2)
    if (lane === -1) lane = laneEnds.push(0) - 1
    laneEnds[lane] = x + labelW / 2
    slots[i] = { above: lane % 2 === 0, level: Math.floor(lane / 2), x }
  }
  return slots
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
  const theme = useTheme()
  const { width: measured, containerRef } = useContainerWidth()
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (!milestones.length)
    return (
      <Typography color="text.secondary" sx={{ p: 2 }}>
        {t('No milestones yet.')}
      </Typography>
    )
  const { pos, todayPos } = roadmapPositions(milestones, today)
  // Labels wrap in full, so the bands above and below the line grow with the longest name.
  // shortcut: ~16 body2 characters per 140 px line, measure the DOM if names still overflow.
  const LABEL_H = 36 + 20 * Math.max(...milestones.map((m) => Math.ceil(m.name.length / 16) || 1))
  const minWidth = Math.max(600, milestones.length * 110)
  // Before the first measure (and in tests) the line is drawn at its minimum width.
  const width = measured || minWidth
  const slots = roadmapLabelSlots(pos, width)
  const levels = (above: boolean) => 1 + Math.max(0, ...slots.filter((s) => s.above === above).map((s) => s.level))
  const topH = levels(true) * LABEL_H
  const height = topH + LINE_H + levels(false) * LABEL_H
  const lineY = topH + LINE_H / 2
  // The label's edge facing the line.
  const edgeY = (s: LabelSlot) => (s.above ? topH - s.level * LABEL_H : topH + LINE_H + s.level * LABEL_H)
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
      {/* Each label takes the nearest free lane above or below the line; one away from its
          milestone is tied to it by a rope. */}
      <Box
        ref={containerRef}
        role="img"
        aria-label={t('Roadmap')}
        sx={{ position: 'relative', height, minWidth, mx: 8 }}
      >
        <svg width={width} height={height} style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none', overflow: 'visible' }} aria-hidden>
          {slots.map((s, i) => {
            const x = (pos[i] / 100) * width
            if (s.level === 0 && Math.abs(s.x - x) < 1) return null
            return (
              <line
                key={milestones[i].id}
                data-testid={`gantt-roadmap-rope-${milestones[i].id}`}
                x1={x}
                y1={lineY + (s.above ? -8 : 8)}
                x2={s.x}
                y2={edgeY(s)}
                stroke={theme.palette.text.secondary}
                strokeWidth={1}
                strokeDasharray="3 3"
              />
            )
          })}
        </svg>
        <Box
          sx={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: lineY - 2,
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
            top: topH - 6,
            height: LINE_H + 12,
            width: 2,
            bgcolor: 'error.main',
            transform: 'translateX(-50%)',
          }}
          style={{ left: (todayPos / 100) * width }}
        />
        {milestones.map((m, i) => {
          const status = milestoneStatus(m, today)
          const slot = slots[i]
          return (
            <Box key={m.id}>
              <Box
                data-testid={`gantt-roadmap-milestone-${m.id}`}
                sx={{
                  position: 'absolute',
                  top: lineY,
                  width: 16,
                  height: 16,
                  transform: 'translate(-50%, -50%) rotate(45deg)',
                  bgcolor: COLOR[status],
                }}
                style={{ left: (pos[i] / 100) * width }}
              />
              <Box
                data-testid={`gantt-roadmap-label-${m.id}`}
                data-lane={`${slot.above ? 'above' : 'below'}-${slot.level}`}
                sx={{
                  position: 'absolute',
                  width: LABEL_W,
                  height: LABEL_H,
                  boxSizing: 'border-box',
                  transform: 'translateX(-50%)',
                  textAlign: 'center',
                  display: 'flex',
                  flexDirection: 'column',
                  // The text sits against the edge facing the line.
                  justifyContent: slot.above ? 'flex-end' : 'flex-start',
                  py: 0.5,
                }}
                style={{ left: slot.x, top: slot.above ? edgeY(slot) - LABEL_H : edgeY(slot) }}
                title={`${m.name}: ${m.day.toLocaleDateString()}`}
              >
                <Typography variant="body2" sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
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
