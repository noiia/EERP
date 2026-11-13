'use client'
import type { ReactNode } from 'react'
import Box from '@mui/material/Box'
import Link from '@mui/material/Link'
import Typography from '@mui/material/Typography'

// The subset the composer's formatting panel writes: never raw HTML, so a message can't inject markup.
const INLINE = /`([^`\n]+)`|\*\*(.+?)\*\*|~~(.+?)~~|\*([^*\s](?:[^*\n]*?[^*\s])?)\*|\[([^\]\n]+)\]\(([^)\s]+)\)/
const SAFE_URL = /^(https?:\/\/|mailto:)/i

const codeSx = { fontFamily: 'monospace', bgcolor: 'action.hover', borderRadius: 0.5, px: 0.5 }

export function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let rest = text
  for (let k = 0; rest; k++) {
    const m = INLINE.exec(rest)
    if (!m) {
      out.push(rest)
      break
    }
    if (m.index > 0) out.push(rest.slice(0, m.index))
    const [all, code, bold, strike, italic, label, url] = m
    if (code !== undefined) out.push(<Box component="code" key={k} sx={codeSx}>{code}</Box>)
    else if (bold !== undefined) out.push(<strong key={k}>{renderInline(bold)}</strong>)
    else if (strike !== undefined) out.push(<s key={k}>{renderInline(strike)}</s>)
    else if (italic !== undefined) out.push(<em key={k}>{renderInline(italic)}</em>)
    else if (SAFE_URL.test(url)) out.push(<Link key={k} href={url} target="_blank" rel="noopener noreferrer">{label}</Link>)
    else out.push(all)
    rest = rest.slice(m.index + all.length)
  }
  return out
}

const LINE_KINDS: [RegExp, string][] = [
  [/^(#{1,3}) (.*)$/, 'heading'],
  [/^> ?(.*)$/, 'quote'],
  [/^[-*] (.*)$/, 'ul'],
  [/^\d+[.)] (.*)$/, 'ol'],
]

function kindOf(line: string): [string, RegExpExecArray | null] {
  for (const [re, kind] of LINE_KINDS) {
    const m = re.exec(line)
    if (m) return [kind, m]
  }
  return ['text', null]
}

/** A chat message body rendered from its Markdown subset (titles, bold, italic, strikethrough, code, quotes, lists, links). */
export function Markdown({ text }: { text: string }) {
  const lines = text.split('\n')
  const blocks: ReactNode[] = []
  for (let i = 0; i < lines.length; ) {
    const k = blocks.length
    if (lines[i].startsWith('```')) {
      const end = lines.indexOf('```', i + 1)
      const stop = end === -1 ? lines.length : end
      blocks.push(
        <Box component="pre" key={k} sx={{ ...codeSx, p: 1, my: 0.5, overflowX: 'auto', whiteSpace: 'pre' }}>
          {lines.slice(i + 1, stop).join('\n')}
        </Box>,
      )
      i = stop + 1
      continue
    }
    const [kind, m] = kindOf(lines[i])
    if (kind === 'heading') {
      blocks.push(
        <Typography key={k} variant={(['h6', 'subtitle1', 'subtitle2'] as const)[m![1].length - 1]} component="p" sx={{ fontWeight: 700 }}>
          {renderInline(m![2])}
        </Typography>,
      )
      i++
      continue
    }
    // Consecutive lines of the same kind form one block.
    const group: string[] = []
    while (i < lines.length && !lines[i].startsWith('```') && kindOf(lines[i])[0] === kind) {
      const mm = kindOf(lines[i])[1]
      group.push(mm ? mm[1] : lines[i])
      i++
    }
    if (kind === 'quote') {
      blocks.push(
        <Box key={k} component="blockquote" sx={{ m: 0, my: 0.5, pl: 1.5, borderLeft: 3, borderColor: 'divider', color: 'text.secondary', whiteSpace: 'pre-wrap' }}>
          {renderInline(group.join('\n'))}
        </Box>,
      )
    } else if (kind === 'ul' || kind === 'ol') {
      blocks.push(
        <Box key={k} component={kind} sx={{ m: 0, pl: 3 }}>
          {group.map((g, j) => <li key={j}>{renderInline(g)}</li>)}
        </Box>,
      )
    } else {
      blocks.push(<span key={k}>{renderInline(group.join('\n'))}</span>)
    }
  }
  return (
    <Typography variant="body2" component="div" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
      {blocks}
    </Typography>
  )
}
