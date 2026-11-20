import { jsPDF } from 'jspdf'
import { strToU8, zipSync } from 'fflate'
import type { RegisterCell, RegisterTable } from './register-table'

// Writers of the risk register table (register-table.ts): CSV, XLSX and PDF. Loaded on demand.

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

/** A minimal XLSX workbook (one sheet, inline strings, numbers as numbers, bold header row). */
export function registerXlsx(table: RegisterTable, sheet = 'Risk register'): Uint8Array {
  const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
  const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships'
  const row = (cells: RegisterCell[], r: number, style: string) =>
    `<row r="${r}">${cells
      .map((v, i) => {
        const ref = `${column(i)}${r}`
        if (v == null) return ''
        if (typeof v === 'number') return `<c r="${ref}"${style}><v>${v}</v></c>`
        return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xml(v)}</t></is></c>`
      })
      .join('')}</row>`
  const cols = table.heads.map((_, i) => `<col min="${i + 1}" max="${i + 1}" width="${i === 0 || i === 7 ? 40 : 16}" customWidth="1"/>`).join('')
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
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="${NS}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>`,
    ),
    'xl/worksheets/sheet1.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${NS}"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${cols}</cols><sheetData>${row(table.heads, 1, ' s="1"')}${table.rows.map((r, i) => row(r, i + 2, '')).join('')}</sheetData></worksheet>`,
    ),
  })
}

// Relative column widths of the PDF table: the free texts (risk, remediation) get the room.
const PDF_WIDTHS = [3, 1.6, 1.2, 1, 1, 1.1, 1, 3, 1.6, 1.3, 1.1]

/** A landscape A4 PDF: title and date, then the table, wrapped and paged, header repeated. */
export function registerPdf(table: RegisterTable, title: string, date: Date): jsPDF {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
  const pageW = doc.internal.pageSize.getWidth()
  const pageH = doc.internal.pageSize.getHeight()
  const m = 10
  const total = PDF_WIDTHS.reduce((a, b) => a + b, 0)
  const widths = PDF_WIDTHS.map((w) => (w / total) * (pageW - m * 2))
  const lineH = 3.6
  const pad = 1.2
  doc.setFontSize(12)
  doc.text(title, m, m + 4)
  doc.text(date.toLocaleDateString(), pageW - m, m + 4, { align: 'right' })
  let y = m + 10
  const draw = (cells: RegisterCell[], bold: boolean) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal')
    doc.setFontSize(8)
    const wrapped = cells.map((v, i) => doc.splitTextToSize(v == null ? '—' : String(v), widths[i] - pad * 2) as string[])
    const h = Math.max(...wrapped.map((l) => l.length)) * lineH + pad * 2
    if (y + h > pageH - m) {
      doc.addPage()
      y = m
      if (!bold) draw(table.heads, true)
    }
    let x = m
    wrapped.forEach((l, i) => {
      if (bold) {
        doc.setFillColor(241, 245, 249)
        doc.rect(x, y, widths[i], h, 'F')
      }
      doc.setDrawColor(203, 213, 225)
      doc.rect(x, y, widths[i], h)
      doc.text(l, x + pad, y + pad + lineH - 0.8)
      x += widths[i]
    })
    y += h
  }
  draw(table.heads, true)
  for (const r of table.rows) draw(r, false)
  return doc
}

/** Saves the register in `kind`'s format as `<filename>.<ext>`. */
export function downloadRegister(kind: 'csv' | 'xlsx' | 'pdf', table: RegisterTable, title: string, filename: string, sheet?: string) {
  if (kind === 'pdf') return registerPdf(table, title, new Date()).save(`${filename}.pdf`)
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
