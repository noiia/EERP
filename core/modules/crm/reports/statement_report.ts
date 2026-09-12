import { reportTitleSection, type ReportDescriptor } from '@eerp/core-front'

// crm.statement — the first real ReportDescriptor (docs/roadmaps/pdf-reports.md
// Phase 4), proving the pipeline end to end on a real business document rather
// than the throwaway fixtures Phases 2/3 verified against. className values are
// the print stylesheet's hooks (apps/shell/app/print/report/report.css) — plain
// CSS rather than Tailwind/MUI, since neither is installed in this frontend
// (MUI ships React components, not utility classes; ReportRenderer deliberately
// renders plain DOM, no MUI, so a report stays lightweight for pdf-service to
// print). No `table` node: Go's GET /crm/:id response carries no embedded
// array-valued field (tags is a many2many resolved lazily, client-side only,
// per ADR-010's Phase 2 finding) — a real relation table is future work once a
// report actually needs one, not a Phase 4 gap. Likewise NO
// reportMastheadSection/reportPartyAddressFields: that helper's two-party
// (company left / contact right) address block needs real *_address_* columns
// on both sides, and a crm row has neither an issuer/customer split nor any
// address columns at all — it's one contact, not a billing document between
// two parties. Bolting fabricated field names onto it would violate this very
// module's own "every printed field is a real, declared crm field" test
// (../crm_views.test.ts). `reportTitleSection('name')` DOES fit, since `name`
// is a real, already-editable field.
export const statementReport: ReportDescriptor = {
  name: 'crm.statement',
  entity: 'crm',
  permissions: ['crm:contacts:read'],
  layout: [
    reportTitleSection('name'),
    {
      kind: 'section',
      className: 'eerp-report-header',
      children: [{ kind: 'field', name: 'company' }, { kind: 'field', name: 'status' }],
    },
    {
      kind: 'section',
      className: 'eerp-report-contact',
      children: [
        { kind: 'field', name: 'email' },
        { kind: 'field', name: 'phone' },
      ],
    },
    {
      kind: 'section',
      className: 'eerp-report-metrics',
      children: [
        { kind: 'field', name: 'satisfaction', format: 'number' },
        { kind: 'field', name: 'deals', format: 'number' },
        { kind: 'field', name: 'score', format: 'number' },
      ],
    },
    { kind: 'pageBreak' },
    {
      kind: 'section',
      className: 'eerp-report-notes',
      children: [{ kind: 'field', name: 'notes' }],
    },
  ],
}
