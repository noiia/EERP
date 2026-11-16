'use client'
import { useTheme } from '@mui/material/styles'
import { useT } from '../../i18n/translate'
import { bandMain } from './risk-matrix'
import { band, ishikawaBones, type RiskRow } from './scoring'

const MAX_LABELS = 8
const LINE = 22
const BONE_W = 260
const PAD = 40
const HEAD_W = 180

export const ISHIKAWA_HEIGHT = 2 * (MAX_LABELS + 2) * LINE + 2 * PAD

// SVG text never wraps or clips: labels are cut to what fits their box (full text in the tooltip).
const HEAD_CHARS = 18
const BONE_CHARS = 26
const RISK_CHARS = 30
export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

export function ishikawaWidth(bones: number) {
  return Math.max(Math.ceil(bones / 2), 1) * BONE_W + HEAD_W + PAD * 2
}

// Fishbone: the spine ends in the project's head box; bones alternate above and below it,
// each carrying its category's risks (most critical first), at most MAX_LABELS then "+N more".
export function Ishikawa({ rows, categories, project, onOpen }: {
  rows: RiskRow[]
  categories: { id: string; name: string }[]
  project: string
  onOpen: (id: string) => void
}) {
  const t = useT()
  const th = useTheme()
  const bones = ishikawaBones(rows, categories)
  const width = ishikawaWidth(bones.length)
  const mid = ISHIKAWA_HEIGHT / 2
  const headX = width - PAD - HEAD_W
  const stroke = th.palette.text.secondary
  const text = th.palette.text.primary
  return (
    <svg
      viewBox={`0 0 ${width} ${ISHIKAWA_HEIGHT}`}
      width="100%"
      height="100%"
      preserveAspectRatio="xMidYMid meet"
      role="img" aria-label={t('Ishikawa')} style={{ background: th.palette.background.paper }}>
      <line x1={PAD} y1={mid} x2={headX} y2={mid} stroke={stroke} strokeWidth={3} />
      <rect x={headX} y={mid - 24} width={HEAD_W} height={48} rx={6} fill={th.palette.primary.main} />
      <text x={headX + HEAD_W / 2} y={mid + 5} textAnchor="middle" fill={th.palette.primary.contrastText} fontWeight={700}>
        <title>{project}</title>
        {clip(project, HEAD_CHARS)}
      </text>
      {bones.map((b, i) => {
        const up = i % 2 === 0
        const x = PAD + Math.floor(i / 2) * BONE_W + BONE_W / 2
        const sign = up ? -1 : 1
        const tipY = mid + sign * (ISHIKAWA_HEIGHT / 2 - PAD)
        const shown = b.risks.slice(0, MAX_LABELS)
        return (
          <g key={b.id ?? 'none'} data-testid={`bone-${b.id ?? 'none'}`}>
            <line x1={x - 60} y1={tipY} x2={x} y2={mid} stroke={stroke} strokeWidth={2} />
            <text x={x - 60} y={tipY + sign * -8} textAnchor="middle" fill={text} fontWeight={700}>
              <title>{b.id ? b.name : t('Uncategorized')}</title>
              {clip(b.id ? b.name : t('Uncategorized'), BONE_CHARS)}
            </text>
            {shown.map((r, j) => {
              const y = mid + sign * (30 + j * LINE)
              return (
                <text
                  key={r.id}
                  x={x - 8}
                  y={y}
                  textAnchor="end"
                  fill={bandMain(th, band(r.criticity))}
                  fontSize={13}
                  style={{ cursor: 'pointer' }}
                  onClick={() => onOpen(r.id)}
                >
                  <title>{r.name}</title>
                  {clip(r.name, RISK_CHARS)}
                </text>
              )
            })}
            {b.risks.length > MAX_LABELS && (
              <text x={x - 8} y={mid + sign * (30 + MAX_LABELS * LINE)} textAnchor="end" fill={stroke}>
                {`+${b.risks.length - MAX_LABELS} ${t('more')}`}
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}
