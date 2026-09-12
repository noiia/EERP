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
  /**
   * Multi-company: when the record's own `name` value is empty, the print
   * route substitutes this field from the caller's active company profile
   * instead (e.g. sale.invoice's issuer_name falling back to the active
   * company's own name) — see report-chrome.ts's sibling resolution and
   * reportCompanyFallbackFields() below. Absent means no fallback; the
   * record's own value (however empty) always renders as-is.
   */
  companyFallback?:
    | 'name'
    | 'address_number'
    | 'address_complement'
    | 'address_street'
    | 'address_zip_code'
    | 'address_city'
    | 'address_state'
    | 'address_country'
    | 'phone'
    | 'email'
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
  /**
   * Name the print route assigns the resolved rows to on the fetched
   * record — same "property on the record" contract `ReportFieldNode.name`
   * and `ReportImageNode.source` use, just written to rather than read
   * from when `relation` is set (below).
   */
  source: string
  columns: ReportTableColumn[]
  className?: string
  /**
   * When the rows are NOT an embedded array field but their own child
   * table (e.g. sale.SaleLine, one row per invoice line), the print route
   * fetches `entity` filtered by `inverseField = <record id>` and assigns
   * the result onto `record[source]` before ReportRenderer ever sees it —
   * same "resolve into the record object first" posture the picture/
   * company-fallback resolution already uses (reportImageSources/
   * reportCompanyFallbackFields), and the same `{entity, inverseField}`
   * shape `RelationField` uses for a one2many `ViewDescriptor` field.
   * Omitted (the original, still-supported shape): `source` is read
   * directly off the record as-is, e.g. crm.statement's embedded array.
   */
  relation?: { entity: string; inverseField: string }
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
 * Every `field` node's (record field name, company field name) pair that
 * opted into a company fallback, recursing into sections — mirrors
 * reportImageSources' shape exactly. The print route is the one place that
 * knows both the fetched record and the caller's active company, so it (not
 * ReportRenderer) applies the fallback before rendering.
 */
export function reportCompanyFallbackFields(
  descriptor: ReportDescriptor,
): { recordField: string; companyField: string }[] {
  const fields: { recordField: string; companyField: string }[] = []
  const visit = (node: ReportNode): void => {
    if (node.kind === 'field' && node.companyFallback) {
      fields.push({ recordField: node.name, companyField: node.companyFallback })
    } else if (node.kind === 'section') {
      for (const child of node.children) visit(child)
    }
  }
  for (const node of descriptor.layout) visit(node)
  return fields
}

/**
 * Every `table` node's (source, entity, inverseField) triple that opted
 * into relation resolution, recursing into sections — mirrors
 * reportImageSources'/reportCompanyFallbackFields' shape exactly. The print
 * route is the one place that knows both the fetched record's id and a
 * usable auth token, so it (not ReportRenderer) fetches the child rows and
 * assigns them onto the record before rendering.
 */
export function reportTableRelations(
  descriptor: ReportDescriptor,
): { source: string; entity: string; inverseField: string }[] {
  const relations: { source: string; entity: string; inverseField: string }[] = []
  const visit = (node: ReportNode): void => {
    if (node.kind === 'table' && node.relation) {
      relations.push({ source: node.source, entity: node.relation.entity, inverseField: node.relation.inverseField })
    } else if (node.kind === 'section') {
      for (const child of node.children) visit(child)
    }
  }
  for (const node of descriptor.layout) visit(node)
  return relations
}

/**
 * Field names for one "party" address block (company or contact), derived
 * from a record field prefix — e.g. prefix 'issuer' -> 'issuer_name',
 * 'issuer_address_street', etc. Mirrors sale.invoice's own issuer_ / customer_
 * naming convention, just generalized so any report's entity can reuse it
 * under its own prefix.
 */
function partyFieldNames(prefix: string) {
  return {
    name: `${prefix}_name`,
    addressNumber: `${prefix}_address_number`,
    addressStreet: `${prefix}_address_street`,
    addressComplement: `${prefix}_address_complement`,
    addressZipCode: `${prefix}_address_zip_code`,
    addressCity: `${prefix}_address_city`,
    addressCountry: `${prefix}_address_country`,
  }
}

/**
 * The address block's field lines, in print order: name, then (number,
 * street) as a row, complement, then (zip code, city) as a row, then
 * country — the shape every "current company data" / "contact data" ask
 * boils down to. `companyFallback` opts every field EXCEPT address number
 * into the active-company fallback: `address_number` is deliberately left
 * out — company[companyField] ?? '' can't distinguish "blank" from a
 * legitimate 0 the way it can for the string fields (sale.invoice's own
 * issuer masthead hit this first; kept here so every caller gets the fix for
 * free instead of rediscovering it).
 */
export function reportPartyAddressFields(prefix: string, companyFallback: boolean): ReportNode[] {
  const fields = partyFieldNames(prefix)
  const fb = <T extends ReportFieldNode['companyFallback']>(suffix: T): T | undefined =>
    companyFallback ? suffix : undefined
  return [
    { kind: 'field', name: fields.name, companyFallback: fb('name') },
    {
      kind: 'section',
      className: 'eerp-report-subject',
      children: [
        { kind: 'field', name: fields.addressNumber },
        { kind: 'field', name: fields.addressStreet, companyFallback: fb('address_street') },
      ],
    },
    { kind: 'field', name: fields.addressComplement, companyFallback: fb('address_complement') },
    {
      kind: 'section',
      className: 'eerp-report-subject',
      children: [
        { kind: 'field', name: fields.addressZipCode, companyFallback: fb('address_zip_code') },
        { kind: 'field', name: fields.addressCity, companyFallback: fb('address_city') },
      ],
    },
    { kind: 'field', name: fields.addressCountry, companyFallback: fb('address_country') },
  ]
}

/**
 * The standard report masthead (docs/roadmaps/pdf-reports.md): the printing
 * company's own address top-left (falling back to the printing user's
 * active company profile when the record's own fields are blank — the same
 * `companyFallback` mechanism sale.invoice pioneered by hand), and the
 * record's OTHER party — customer, tenant, whoever the document is addressed
 * to — top-right, from its own fields with no fallback. Reuses
 * `eerp-report-parties`/`eerp-report-issuer`/`eerp-report-client`
 * (report.css), the exact layout sale.invoice already established, so every
 * report gets the same look "by design" instead of hand-rolling this tree
 * per module. `companyPrefix`/`contactPrefix` name each side's record field
 * prefix (e.g. 'issuer' / 'customer') — the entity must actually declare
 * those columns; this only assembles the layout tree, it invents no fields.
 * A report needing extra fields alongside the address block (e.g. phone/
 * email) should compose `reportPartyAddressFields` directly instead — see
 * sale.invoice/sale.quote.
 */
export function reportMastheadSection(opts: { companyPrefix: string; contactPrefix: string }): ReportSectionNode {
  return {
    kind: 'section',
    className: 'eerp-report-parties',
    children: [
      { kind: 'section', className: 'eerp-report-issuer', children: reportPartyAddressFields(opts.companyPrefix, true) },
      { kind: 'section', className: 'eerp-report-client', children: reportPartyAddressFields(opts.contactPrefix, false) },
    ],
  }
}

/**
 * A big, bold document name/title — printed oversized (report.css's
 * `eerp-report-title`) below the masthead, the way a letterhead's document
 * name reads. `field` is a plain record field the module's own form still
 * owns (editable there, like any other field — "I can edit manually later"
 * is just that form field, not a print-time input).
 */
export function reportTitleSection(field: string): ReportFieldNode {
  return { kind: 'field', name: field, className: 'eerp-report-title' }
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
        if (node.relation && (!node.relation.entity || !node.relation.inverseField)) {
          throw new Error(`table "${node.source}" relation requires both entity and inverseField`)
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
