// Report descriptors — the metadata a module contributes to generate a PDF
// report (docs/adr/ADR-010, docs/roadmaps/pdf-reports.md). Mirrors
// ViewDescriptor's "descriptors only" contract: a module declares WHAT a
// report shows; ReportRenderer (this package) and the print route
// (apps/shell/app/print/report/[name]/[id]/page.tsx) derive HOW it prints.
// Unlike ViewDescriptor, a report has no separate `fields` registry — a
// field LEAF's `name` is looked up directly on the fetched record — so there
// is no widget/type matrix here, only structural validation.

export interface ReportSectionNode {
  kind: 'section'
  /** Tailwind/MUI class applied to the rendered wrapper — the report's
   * styling hook, since ReportRenderer renders plain DOM, not MUI components. */
  className?: string
  children: ReportNode[]
}

export interface ReportFieldNode {
  kind: 'field'
  /** Property name on the fetched record. */
  name: string
  className?: string
  /** Built-in value formatter; omitted renders the raw value coerced to a string. */
  format?: 'number' | 'date' | 'datetime'
}

/**
 * A literal caption — a label, a legal notice, anything that isn't looked up
 * on the record. `ReportFieldNode` never carries a label of its own (crm.
 * statement's whole layout is label-less, styled sections of raw values),
 * so a document that needs "Total HT" printed next to its amount needs a
 * node for the words themselves. `text` is source-language content the
 * module author writes directly in the descriptor (same "TS is data" rule
 * as everything else here) — it does not currently flow through the
 * translation catalogs the way `FieldDescriptor.label` does.
 */
export interface ReportTextNode {
  kind: 'text'
  text: string
  className?: string
}

/**
 * An image sourced from the record — the one field type ReportFieldNode
 * can't render as a plain string. `source` names a property on the fetched
 * record the same way `ReportFieldNode.name` does; the print route
 * resolves it before ReportRenderer ever sees it (see
 * apps/shell/app/print/report/[name]/[id]/page.tsx's picture-anchor
 * resolution) — by the time this node renders, the value is either a
 * ready-to-use `data:`/`http(s):` URL string or absent. Absent renders
 * nothing: a company that never uploaded a logo prints a document with no
 * broken-image icon, not an error.
 */
export interface ReportImageNode {
  kind: 'image'
  source: string
  className?: string
  alt?: string
}

export interface ReportTableColumn {
  /** Property name on each row object. */
  name: string
  label: string
}

export interface ReportTableNode {
  kind: 'table'
  /** Name of an array-valued field on the record (e.g. embedded line items). */
  source: string
  columns: ReportTableColumn[]
  className?: string
}

export interface ReportPageBreakNode {
  kind: 'pageBreak'
}

export type ReportNode =
  | ReportSectionNode
  | ReportFieldNode
  | ReportTableNode
  | ReportPageBreakNode
  | ReportTextNode
  | ReportImageNode

export interface ReportDescriptor {
  /** Also the print route's :name param (e.g. 'crm.statement'). */
  name: string
  /** Data source entity — the same entity names ViewDescriptor.entity uses. */
  entity: string
  layout: ReportNode[]
  /** Permissions required to generate — enforced by Go (Phase 3's dedicated
   * report route), mirrored here so the descriptor documents its own gate. */
  permissions: string[]
  /**
   * Names a report_page_format row (Settings -> Global settings -> Reports)
   * this report opts into for page size/padding/colors/footer/address —
   * absent means the print route uses the built-in defaults and the global
   * reports.layout footer/address only (see report-chrome.ts's
   * resolveReportChrome). Descriptor-opt-in only; there is no export-time
   * picker.
   */
  pageFormat?: string
}

/**
 * Every `image` node's `source` field name in a report's layout, recursing
 * into sections. The print route's own need (apps/shell/app/print/report/
 * [name]/[id]/page.tsx): it's the one place that knows both the fetched
 * record and a usable auth token, so it — not ReportRenderer, which stays a
 * pure, synchronous, record-only view — is where a picture-flag field gets
 * resolved to a `data:` URL before rendering.
 */
export function reportImageSources(descriptor: ReportDescriptor): string[] {
  const sources: string[] = []
  const visit = (node: ReportNode): void => {
    if (node.kind === 'image') sources.push(node.source)
    else if (node.kind === 'section') for (const child of node.children) visit(child)
  }
  for (const node of descriptor.layout) visit(node)
  return sources
}

/**
 * Validate a report descriptor at registration: every field-leaf needs a
 * name, every table-leaf needs a source and at least one named column — the
 * same "fail at registration, not at render" discipline
 * validateDescriptorWidgets already applies to ViewDescriptor. Errors name
 * the offending node.
 */
export function validateReportDescriptor(descriptor: ReportDescriptor): void {
  const visit = (node: ReportNode): void => {
    switch (node.kind) {
      case 'field':
        if (!node.name) throw new Error(`a "field" node requires a name`)
        return
      case 'table':
        if (!node.source) throw new Error(`a "table" node requires a source`)
        if (node.columns.length === 0) {
          throw new Error(`table "${node.source}" requires at least one column`)
        }
        for (const col of node.columns) {
          if (!col.name) throw new Error(`table "${node.source}" has a column with no name`)
        }
        return
      case 'pageBreak':
        return
      case 'text':
        if (!node.text) throw new Error(`a "text" node requires text`)
        return
      case 'image':
        if (!node.source) throw new Error(`an "image" node requires a source`)
        return
      case 'section':
        for (const child of node.children) visit(child)
        return
    }
  }
  for (const node of descriptor.layout) visit(node)
}
