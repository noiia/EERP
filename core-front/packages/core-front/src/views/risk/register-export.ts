import { jsPDF } from 'jspdf'
import { strToU8, zipSync } from 'fflate'
import type { RegisterCell, RegisterTable } from './register-table'
import type { Rgb, RiskRow } from './scoring'
import { RESIDUAL_COLORS, SHEET_HEADER, SHEET_HEADS, SHEET_INK, SHEET_LINE, SHEET_WIDTHS, cellFill, legendScale, registerSheet } from './register-sheet'

// Writers of the risk register: the full table (register-table.ts) as CSV and XLSX, the sheet
// (register-sheet.ts) as PDF. Loaded on demand.

/** CSV (RFC 4180, UTF-8 with a BOM so Excel reads accents). A text cell a spreadsheet would run
 * as a formula (=, +, -, @, tab, CR first) is prefixed with ' — risk texts are user input. */
export function registerCsv(table: RegisterTable): string {
  const cell = (v: RegisterCell) => {
    if (v == null) return ''
    let s = String(v)
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`
    return /[",\r\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return '﻿' + [table.heads, ...table.rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n'
}

// XML text: escaped, with the control characters XML 1.0 forbids dropped.
// eslint-disable-next-line no-control-regex -- matching those characters is the point
const forbidden = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g
const xml = (s: string) =>
  s.replace(forbidden, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const column = (i: number): string => (i < 26 ? '' : column(Math.floor(i / 26) - 1)) + String.fromCharCode(65 + (i % 26))

const hex = (c: [number, number, number]) => c.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()

/** A minimal XLSX workbook (one sheet, inline strings, numbers as numbers, bold header row,
 * each row filled with its `fills` color when set). */
export function registerXlsx(table: RegisterTable, sheet = 'Risk register'): Uint8Array {
  const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
  const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships'
  const row = (cells: RegisterCell[], r: number, style: string) =>
    `<row r="${r}"${style && ` customFormat="1"${style}`}>${cells
      .map((v, i) => {
        const ref = `${column(i)}${r}`
        if (v == null) return ''
        if (typeof v === 'number') return `<c r="${ref}"${style}><v>${v}</v></c>`
        return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xml(v)}</t></is></c>`
      })
      .join('')}</row>`
  const cols = table.heads.map((_, i) => `<col min="${i + 1}" max="${i + 1}" width="${i === 0 || i === 7 ? 40 : 16}" customWidth="1"/>`).join('')
  // One fill + cell style per distinct row color: style 2 + i uses fill 2 + i.
  const colors = [...new Set((table.fills ?? []).filter((c) => c).map((c) => hex(c!)))]
  const fills = colors.map((c) => `<fill><patternFill patternType="solid"><fgColor rgb="FF${c}"/><bgColor indexed="64"/></patternFill></fill>`).join('')
  const xfs = colors.map((_, i) => `<xf fillId="${i + 2}" applyFill="1"/>`).join('')
  const rowStyle = (i: number) => {
    const c = table.fills?.[i]
    return c ? ` s="${colors.indexOf(hex(c)) + 2}"` : ''
  }
  const name = xml(sheet.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31))
  return zipSync({
    '[Content_Types].xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    ),
    '_rels/.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    'xl/workbook.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${NS}" xmlns:r="${REL}"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
    ),
    'xl/styles.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="${NS}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="${2 + colors.length}"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>${fills}</fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="${2 + colors.length}"><xf/><xf fontId="1" applyFont="1"/>${xfs}</cellXfs></styleSheet>`,
    ),
    'xl/worksheets/sheet1.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${NS}"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${cols}</cols><sheetData>${row(table.heads, 1, ' s="1"')}${table.rows.map((r, i) => row(r, i + 2, rowStyle(i))).join('')}</sheetData></worksheet>`,
    ),
  })
}

/** A landscape A4 PDF of the sheet (register-sheet.ts): title and date, the table wrapped and paged with its
 * header repeated, then the legend. Same layout and fixed light colors as the PNG. */
export function registerPdf(rows: RiskRow[], title: string, date: Date, t: (s: string) => string = (s) => s): jsPDF {
  const sheet = registerSheet(rows)
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
  const pageW = doc.internal.pageSize.getWidth()
  const pageH = doc.internal.pageSize.getHeight()
  const m = 10
  const total = SHEET_WIDTHS.reduce((a, b) => a + b, 0)
  const widths = SHEET_WIDTHS.map((w) => (w / total) * (pageW - m * 2))
  const lineH = 3.8
  const pad = 2
  const legendH = 8
  doc.setTextColor(...SHEET_INK)
  doc.setFontSize(12)
  doc.setFont('helvetica', 'bold')
  doc.text(title, m, m + 4)
  doc.setFont('helvetica', 'normal')
  doc.text(date.toLocaleDateString(), pageW - m, m + 4, { align: 'right' })
  let y = m + 10
  const draw = (cells: string[], fill: (i: number) => Rgb | null, bold: (i: number) => boolean, header: boolean) => {
    doc.setFontSize(header ? 9 : 8.5)
    const wrapped = cells.map((v, i) => {
      doc.setFont('helvetica', bold(i) ? 'bold' : 'normal')
      return doc.splitTextToSize(v, widths[i] - pad * 2) as string[]
    })
    const h = Math.max(...wrapped.map((l) => l.length)) * lineH + pad * 2
    if (y + h > pageH - m) {
      doc.addPage()
      y = m
      if (!header) drawHead()
    }
    let x = m
    wrapped.forEach((l, i) => {
      const f = fill(i)
      if (f) {
        doc.setFillColor(...f)
        doc.rect(x, y, widths[i], h, 'F')
      }
      doc.setDrawColor(...SHEET_LINE)
      doc.setLineWidth(0.6)
      doc.rect(x, y, widths[i], h)
      doc.setFont('helvetica', bold(i) ? 'bold' : 'normal')
      if (header) doc.setTextColor(255, 255, 255)
      else doc.setTextColor(...SHEET_INK)
      const top = y + (h - l.length * lineH) / 2 + lineH - 0.9
      doc.text(l, x + widths[i] / 2, top, { align: 'center' })
      x += widths[i]
    })
    y += h
  }
  const drawHead = () => draw(SHEET_HEADS.map(t), () => SHEET_HEADER, () => true, true)
  drawHead()
  for (const r of sheet.rows) draw(r.cells, (i) => cellFill(r, i), (i) => i === 0 || i === 1 || i >= 4, false)
  // Legend: the criticity gradient between the sheet's lowest and highest, then the residual bands.
  if (y + legendH + 4 > pageH - m) {
    doc.addPage()
    y = m
  }
  y += legendH
  doc.setFontSize(8)
  doc.setFont('helvetica', 'normal')
  doc.setTextColor(...SHEET_INK)
  let x = m
  const label = (s: string) => {
    doc.text(s, x, y)
    x += doc.getTextWidth(s) + 2
  }
  if (sheet.range) {
    label(`${t('Criticity')} ${sheet.range[0]}`)
    const scale = legendScale(24)
    scale.forEach((c, i) => {
      doc.setFillColor(...c)
      doc.rect(x + i * 1.5, y - 2.8, 1.5, 3, 'F')
    })
    x += scale.length * 1.5 + 2
    label(String(sheet.range[1]))
    x += 8
  }
  label(`${t('Residual')}:`)
  for (const [b, name] of [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']] as const) {
    doc.setFillColor(...RESIDUAL_COLORS[b])
    doc.rect(x + 2, y - 2.8, 3, 3, 'F')
    x += 6
    label(t(name))
  }
  return doc
}

/** Saves the register table as `<filename>.csv` / `.xlsx`. */
export function downloadRegister(kind: 'csv' | 'xlsx', table: RegisterTable, filename: string, sheet?: string) {
  const blob =
    kind === 'csv'
      ? new Blob([registerCsv(table)], { type: 'text/csv;charset=utf-8' })
      : new Blob([registerXlsx(table, sheet) as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url = URL.createObjectURL(blob)
  try {
    const a = document.createElement('a')
    a.download = `${filename}.${kind}`
    a.href = url
    a.click()
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
}
