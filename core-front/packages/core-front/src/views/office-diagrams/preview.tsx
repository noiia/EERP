import type { ReactNode } from 'react'
import { buildWbs, compareOrder } from '../diagram/wbs'
import { layoutPert, layoutWbs } from '../diagram/auto-layout'
import { computePert } from '../diagram/pert'
import {
  matrixCells,
  ishikawaBones,
  band,
  RISK_LIKELIHOODS,
  RISK_SEVERITIES,
  type RiskRow,
} from '../risk/scoring'
import { registerTable } from '../risk/register-table'
import { text, type DiagramData, type DiagramSource, type DiagramSpec } from './model'

type Translate = (s: string) => string
const ink = '#1e293b',
  muted = '#64748b',
  line = '#cbd5e1',
  blue = '#6366f1'
const riskColor = (score: number | null) => {
  const level = band(score)
  return level ? { low: '#047857', medium: '#b45309', high: '#be123c' }[level] : muted
}
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
function lines(s: string, width = 28): string[] {
  const words = s.split(/\s+/),
    out: string[] = []
  let row = ''
  for (const w of words) {
    if (row && row.length + w.length + 1 > width) {
      out.push(row)
      row = ''
    }
    row = row ? row + ' ' + w : w
  }
  if (row) out.push(row)
  return out.slice(0, 3).map((r, i) => clip(r + (i === 2 && out.length > 3 ? '…' : ''), width + 2))
}
const label = (
  x: number,
  y: number,
  s: string,
  size = 14,
  color = ink,
  anchor: 'start' | 'middle' | 'end' = 'start',
) => (
  <text x={x} y={y} fontSize={size} fill={color} textAnchor={anchor}>
    {s}
  </text>
)
const date = (v: unknown) => {
  const n = Date.parse(text(v))
  return Number.isFinite(n) ? n : null
}

function gantt(data: DiagramData, source: DiagramSource, t: Translate) {
  const m = source.defaults
  const rows = [...data.rows].sort((a, b) =>
    compareOrder(text(a[m.wbsOrderField ?? '']), text(b[m.wbsOrderField ?? ''])),
  )
  const dates = rows
    .flatMap((r) => [date(r[m.ganttStartField!]), date(r[m.ganttEndField!])])
    .filter((v): v is number => v !== null)
  if (!dates.length)
    return { width: 1000, height: 180, content: label(30, 90, t('No scheduled tasks')) }
  const start = Math.min(...dates),
    end = Math.max(...dates, start + 86400000)
  const x = (n: number) => 320 + ((n - start) / (end - start)) * 640
  const height = 70 + rows.length * 38
  const y = new Map(rows.map((r, i) => [r.id, 65 + i * 38]))
  const shortDate = (n: number) => new Date(n).toISOString().slice(0, 10)
  return {
    width: 1000,
    height,
    content: (
      <>
        <rect width={1000} height={40} rx={6} fill="#f1f5f9" />
        {label(16, 26, t('Tasks'), 14, muted)}
        {Array.from({ length: 5 }, (_, i) => {
          const n = start + ((end - start) * i) / 4
          return (
            <g key={i}>
              <line x1={x(n)} y1={40} x2={x(n)} y2={height} stroke="#e2e8f0" />
              {label(x(n), 26, shortDate(n), 12, muted, 'middle')}
            </g>
          )
        })}
        {rows.map((r, i) => {
          const a = date(r[m.ganttStartField!]),
            b = date(r[m.ganttEndField!]),
            yy = y.get(r.id)!
          return (
            <g key={r.id}>
              {i % 2 === 0 && <rect y={yy - 18} width={1000} height={38} fill="#f8fafc" />}
              {label(16, yy + 5, clip(text(r.name), 36))}
              {a !== null && b !== null && b >= a ? (
                <rect
                  x={x(a)}
                  y={yy - 9}
                  width={Math.max(5, x(b) - x(a))}
                  height={20}
                  rx={5}
                  fill={blue}
                />
              ) : (
                label(330, yy + 5, t('No dates'), 12, muted)
              )}
            </g>
          )
        })}
        {data.links.map((l, i) => {
          const a = rows.find((r) => r.id === l.from),
            b = rows.find((r) => r.id === l.to)
          const endA = a && date(a[m.ganttEndField!]),
            startB = b && date(b[m.ganttStartField!])
          return endA == null || startB == null ? null : (
            <path
              key={i}
              d={`M${x(endA)},${y.get(l.from)} H${x(endA) + 10} V${y.get(l.to)} H${x(startB)}`}
              fill="none"
              stroke={muted}
              strokeWidth={1.3}
              markerEnd="url(#office-arrow)"
            />
          )
        })}
      </>
    ),
  }
}

function graph(data: DiagramData, source: DiagramSource, spec: DiagramSpec, t: Translate) {
  const m = source.defaults
  const size = { w: 230, h: 100 }
  const rows = data.rows
  const tree = buildWbs(
    rows.map((r) => ({
      id: r.id,
      parentId: text(r[spec.kind === 'wbs' ? m.wbsParentField! : 'parent_id']) || null,
      order: text(r[m.wbsOrderField ?? '']),
    })),
    new Set(),
  )
  const pert =
    spec.kind === 'pert'
      ? computePert(
          rows.map((r) => ({
            id: r.id,
            plannedHours:
              typeof r[m.pertHoursField ?? ''] === 'number' ? Number(r[m.pertHoursField!]) : null,
            dateStart: text(r[m.ganttStartField ?? '']),
            deadline: text(r[m.ganttEndField ?? '']),
          })),
          data.links,
          data.loadedAt,
        )
      : null
  const positions = pert
    ? layoutPert(
        rows.map((r) => r.id),
        data.links,
        size,
      )
    : layoutWbs(tree.nodes, tree.roots, tree.visible, size)
  const edges = pert
    ? data.links
    : rows.flatMap((r) => {
        const parent = tree.nodes[r.id].parentId
        return parent ? [{ from: parent, to: r.id }] : []
      })
  const width = Math.max(700, ...Object.values(positions).map((p) => p.x + size.w + 20))
  const height =
    Math.max(180, ...Object.values(positions).map((p) => p.y + size.h + 20)) +
    (pert?.cycle ? 35 : 0)
  return {
    width,
    height,
    content: (
      <>
        {edges.map((e, i) => {
          const a = positions[e.from],
            b = positions[e.to]
          if (!a || !b) return null
          const critical = pert?.criticalLinks.has(`${e.from}->${e.to}`)
          const d = pert
            ? `M${a.x + size.w},${a.y + size.h / 2} C${a.x + size.w + 50},${a.y + size.h / 2} ${b.x - 50},${b.y + size.h / 2} ${b.x},${b.y + size.h / 2}`
            : `M${a.x + size.w / 2},${a.y + size.h} V${(a.y + size.h + b.y) / 2} H${b.x + size.w / 2} V${b.y}`
          return (
            <path
              key={i}
              d={d}
              fill="none"
              stroke={critical ? '#dc2626' : line}
              strokeWidth={2}
              markerEnd="url(#office-arrow)"
            />
          )
        })}
        {rows.map((r) => {
          const p = positions[r.id],
            n = pert?.nodes[r.id]
          if (!p) return null
          return (
            <g key={r.id} transform={`translate(${p.x},${p.y})`}>
              <rect
                width={size.w}
                height={size.h}
                rx={10}
                fill={n?.critical ? '#fff1f2' : '#f8fafc'}
                stroke={n?.critical ? '#e11d48' : line}
              />
              <rect
                width={4}
                height={size.h - 20}
                x={0}
                y={10}
                rx={2}
                fill={n?.critical ? '#e11d48' : blue}
              />
              {lines(text(r.name) || text(r.text) || '—').map((s, i) => (
                <text key={i} x={14} y={25 + i * 19} fontSize={14} fill={ink} fontWeight={600}>
                  {s}
                </text>
              ))}
              {n
                ? label(
                    14,
                    86,
                    `${n.duration.toFixed(1)} ${t('days')} · ${t('Slack')}: ${n.slack.toFixed(1)}${n.noEstimate ? ' *' : ''}`,
                    11,
                    muted,
                  )
                : label(
                    14,
                    86,
                    clip(text(r.detail) || text(r[m.wbsOrderField ?? '']), 32),
                    12,
                    muted,
                  )}
            </g>
          )
        })}
        {pert?.cycle &&
          label(0, height - 4, t('Dependency cycle: critical path unavailable'), 14, '#b91c1c')}
        {pert &&
          !pert.cycle &&
          rows.some((r) => pert.nodes[r.id].noEstimate) &&
          label(0, height - 2, t('* Estimated duration: 1 day'), 11, muted)}
      </>
    ),
  }
}

function matrix(data: DiagramData, residual: boolean, t: Translate) {
  const rows = data.rows as unknown as RiskRow[]
  const cells = matrixCells(rows, residual)
  const scored = [...cells.values()].flat().length
  const colors = ['#ecfdf5', '#fef3c7', '#ffe4e6']
  return {
    width: 790,
    height: 430,
    content: (
      <>
        {label(30, 24, t(residual ? 'Residual risk' : 'Current risk'), 17, ink)}
        {RISK_LIKELIHOODS.map((l, row) =>
          RISK_SEVERITIES.map((s, col) => {
            const x = 110 + col * 160,
              y = 50 + row * 96,
              risks = cells.get(`${l}:${s}`) ?? []
            return (
              <g key={`${l}:${s}`}>
                <rect
                  x={x}
                  y={y}
                  width={154}
                  height={90}
                  rx={7}
                  fill={colors[l * s <= 4 ? 0 : l * s <= 12 ? 1 : 2]}
                />
                {label(x + 12, y + 24, String(risks.length), 20)}
                {risks.slice(0, 2).map((r, i) => (
                  <g key={r.id}>
                    {label(
                      x + 12,
                      y + 45 + i * 17,
                      clip(r.name, 20),
                      11,
                      riskColor(residual ? r.residual_criticity : r.criticity),
                    )}
                  </g>
                ))}
                {risks.length > 2 && label(x + 12, y + 80, `+${risks.length - 2}`, 11, muted)}
              </g>
            )
          }),
        )}
        {RISK_LIKELIHOODS.map((l, i) => (
          <g key={l}>{label(90, 105 + i * 96, String(l), 14, muted, 'end')}</g>
        ))}
        {RISK_SEVERITIES.map((s, i) => (
          <g key={s}>{label(185 + i * 160, 360, String(s), 14, muted, 'middle')}</g>
        ))}
        <text
          transform="translate(34,190) rotate(-90)"
          textAnchor="middle"
          fill={muted}
          fontSize={14}
        >
          {t('Likelihood')}
        </text>
        {label(430, 392, t('Severity'), 14, muted, 'middle')}
        {label(110, 425, `${t('Unscored risks')}: ${rows.length - scored}`, 12, muted)}
      </>
    ),
  }
}

function fishbone(data: DiagramData, t: Translate) {
  const bones = ishikawaBones(data.rows as unknown as RiskRow[], data.categories)
  const width = Math.max(1, Math.ceil(bones.length / 2)) * 300 + 210
  const height = Math.max(420, ...bones.map((b) => 130 + Math.min(b.risks.length, 12) * 44)),
    mid = height / 2
  return {
    width,
    height,
    content: (
      <>
        <line
          x1={40}
          y1={mid}
          x2={width - 180}
          y2={mid}
          stroke={blue}
          strokeWidth={3}
          markerEnd="url(#office-arrow)"
        />
        <rect
          x={width - 180}
          y={mid - 36}
          width={175}
          height={72}
          rx={10}
          fill="#eef2ff"
          stroke={blue}
        />
        {lines(data.project, 18).map((s, i) => (
          <text
            key={i}
            x={width - 92}
            y={mid - 12 + i * 19}
            textAnchor="middle"
            fill={ink}
            fontWeight={600}
          >
            {s}
          </text>
        ))}
        {bones.map((b, i) => {
          const sign = i % 2 ? 1 : -1,
            x = 150 + Math.floor(i / 2) * 300
          return (
            <g key={b.id ?? 'none'}>
              <line
                x1={x - 30}
                y1={mid + sign * (mid - 38)}
                x2={x + 45}
                y2={mid}
                stroke={line}
                strokeWidth={2}
              />
              {label(
                x - 100,
                sign < 0 ? 20 : height - 10,
                clip(b.id ? b.name : t('Uncategorized'), 30),
                14,
              )}
              {b.risks.slice(0, 12).map((r, j) => (
                <g key={r.id}>
                  {label(
                    x + 20,
                    mid + sign * (32 + j * 21),
                    clip(r.name, 32),
                    12,
                    riskColor(r.criticity),
                    'end',
                  )}
                </g>
              ))}
              {b.risks.length > 12 &&
                label(
                  x + 20,
                  mid + sign * (32 + 12 * 21),
                  `+${b.risks.length - 12}`,
                  12,
                  muted,
                  'end',
                )}
            </g>
          )
        })}
      </>
    ),
  }
}

// Column widths and characters kept per cell: the free texts (risk, remediation) get the room.
const REGISTER_COLS = [
  [220, 30],
  [120, 16],
  [90, 12],
  [80, 10],
  [80, 14],
  [95, 12],
  [75, 10],
  [220, 30],
  [120, 16],
  [95, 12],
  [85, 10],
] as const

function register(data: DiagramData, t: Translate) {
  const rows = [...(data.rows as unknown as (RiskRow & { responsible_name?: string })[])].sort(
    (a, b) => (b.criticity ?? -1) - (a.criticity ?? -1),
  )
  const table = registerTable(rows, data.categories, (r) => (r as { responsible_name?: string }).responsible_name, t)
  const width = REGISTER_COLS.reduce((a, [w]) => a + w, 0)
  const x = REGISTER_COLS.map((_, i) => REGISTER_COLS.slice(0, i).reduce((a, [w]) => a + w, 0))
  const rowH = 30
  const headH = 44
  return {
    width,
    height: headH + rowH * rows.length,
    content: (
      <>
        <rect width={width} height={headH} rx={4} fill="#f1f5f9" />
        {/* Headings wrap on two lines rather than lose their end (translations run long). */}
        {table.heads.map((h, i) => (
          <g key={i}>{lines(h, REGISTER_COLS[i][1]).slice(0, 2).map((l, j) => <g key={j}>{label(x[i] + 8, 18 + j * 15, l, 12, muted)}</g>)}</g>
        ))}
        {table.rows.map((r, i) => {
          const y = headH + rowH * i
          return (
            <g key={rows[i].id}>
              {i % 2 === 1 && <rect y={y} width={width} height={rowH} fill="#f8fafc" />}
              <line x1={0} y1={y} x2={width} y2={y} stroke={line} />
              {r.map((v, j) => <g key={j}>{label(x[j] + 8, y + 20, clip(v == null ? '—' : String(v), REGISTER_COLS[j][1]), 12)}</g>)}
              <circle cx={x[6] + 64} cy={y + 15} r={5} fill={riskColor(rows[i].criticity)} />
            </g>
          )
        })}
      </>
    ),
  }
}

export function DiagramPreview({
  data,
  source,
  spec,
  t,
}: {
  data: DiagramData
  source: DiagramSource
  spec: DiagramSpec
  t: Translate
}) {
  const chart: { width: number; height: number; content: ReactNode } = !data.rows.length
    ? {
        width: 900,
        height: 200,
        content: label(450, 100, t('No records for this diagram'), 18, muted, 'middle'),
      }
    : spec.kind === 'gantt'
      ? gantt(data, source, t)
      : spec.kind === 'risk'
        ? matrix(data, spec.residual, t)
        : spec.kind === 'ishikawa'
          ? fishbone(data, t)
          : spec.kind === 'register'
            ? register(data, t)
            : graph(data, source, spec, t)
  const width = chart.width + 64,
    height = chart.height + 150
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role="img"
      aria-label={spec.title}
      style={{ fontFamily: 'Arial, sans-serif', maxWidth: '100%', height: 'auto' }}
    >
      <rect width={width} height={height} fill="#fff" />
      <defs>
        <marker id="office-arrow" markerWidth={8} markerHeight={8} refX={7} refY={4} orient="auto">
          <path d="M0,0 L8,4 L0,8" fill={muted} />
        </marker>
      </defs>
      {label(32, 36, clip(spec.title, 110), 22)}
      {label(32, 60, clip(data.project, 120), 13, muted)}
      <g transform="translate(32,85)">{chart.content}</g>
      {label(
        32,
        height - 20,
        `${t('Snapshot')} · ${data.loadedAt.toLocaleString()}${data.truncated ? ' · ' + t('Partial diagram: record limit reached') : ''}`,
        12,
        data.truncated ? '#b45309' : muted,
      )}
    </svg>
  )
}

// Only our self-contained SVG is rasterized. No DOM capture, external images or
// fonts; the same preview is embedded in the Office file and its PDF export.
export async function diagramPng(svg: SVGSVGElement) {
  const { width, height } = svg.viewBox.baseVal
  const scale = Math.min(2, 4096 / width, 4096 / height)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const blob = new Blob([new XMLSerializer().serializeToString(svg)], {
    type: 'image/svg+xml;charset=utf-8',
  })
  const url = URL.createObjectURL(blob)
  try {
    const image = new Image()
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('Diagram rendering failed'))
      image.src = url
    })
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas unavailable')
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
    return { image: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height }
  } finally {
    URL.revokeObjectURL(url)
  }
}
