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

export type ReportNode = ReportSectionNode | ReportFieldNode | ReportTableNode | ReportPageBreakNode

export interface ReportDescriptor {
  /** Also the print route's :name param (e.g. 'crm.statement'). */
  name: string
  /** Data source entity — the same entity names ViewDescriptor.entity uses. */
  entity: string
  layout: ReportNode[]
  /** Permissions required to generate — enforced by Go (Phase 3's dedicated
   * report route), mirrored here so the descriptor documents its own gate. */
  permissions: string[]
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
      case 'section':
        for (const child of node.children) visit(child)
        return
    }
  }
  for (const node of descriptor.layout) visit(node)
}
