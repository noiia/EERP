import type { FrontModule, Operation } from '@eerp/core-front'

// crminheritdemo frontend — DESCRIPTORS ONLY, no routes. The Go side already
// proves inheritance on the ORM: crminheritdemo embeds crm.CRM, re-registers
// the "crm" table, and the generic API gains `date`/`comment` — the crm
// module is never touched (see crminheritdemo/module.go). This is the
// frontend half of the SAME proof: crm's OWN views (crm_views.ts) are never
// edited; this module's `extends` reshapes the already-registered `/crm/:id`
// and `/crm/list` routes at registration time (Phase 3's ModuleRegistry),
// exactly mirroring the backend's "declare, don't patch" discipline.
//
// The example is the roadmap's own normative one (docs/roadmaps/
// view-customization.md), adapted to CRM's ACTUAL current shape: the doc was
// written against an early `status` free-text field with a 'lead' value: by
// the time this module landed, `status` had become a `selection` field over
// incoming/running/won/lost/closed (see crm_views.ts) — 'incoming' is the
// equivalent starting state, so the hide-condition below targets that.

const operations: Operation[] = [
  // date/comment back the Go-extended columns (crminheritdemo/module.go:
  // Date *time.Time, Comment *string) — both nullable, per the pitfall
  // pinned by TestExtensionColumnsAreNullable: a non-pointer extension
  // column would 422 every write from crm's OWN form, which has no idea
  // this extension exists.
  { op: 'addField', field: { name: 'date', label: 'Date', type: 'date' }, target: 'status', position: 'after' },
  // widget: 'long' — the "string long" comment field the notebook roadmap names
  // (docs/roadmaps/responsive-displays.md, Phase 4): with no target, it lands
  // on the default form's Settings page with zero extra wiring, proving an
  // EXTENSION-added field reaches the notebook exactly like a base field does.
  { op: 'addField', field: { name: 'comment', label: 'Comment', type: 'text', widget: 'long' } },
  // Reorders the form/list without touching crm_views.ts's field declaration
  // order at all — the layout tree (not `fields[]`) is what moves.
  { op: 'move', name: 'email', target: 'date', position: 'after' },
  // States apply live against the draft (Phase 2) — meaningful on the form
  // (FormRenderer/LayoutForm evaluate them), inert-but-harmless on the list
  // (TreeRenderer never reads `states`, only column order/presence).
  {
    op: 'setField',
    name: 'comment',
    patch: { states: { visible: { field: 'status', op: 'ne', value: 'incoming' } } },
  },
]

const crminheritdemo: FrontModule = {
  name: 'crminheritdemo',
  routes: [],
  extends: [
    { path: '/crm/:id', operations },
    { path: '/crm/list', operations },
  ],
}

export default crminheritdemo
