# ADR-018: One view file per DB model, one file per report

**Status:** Accepted

## Context

Every module's frontend contribution had grown into a single monolithic `<Module>Views.ts`
file under `views/` — `sale/views/SaleViews.ts` reached 892 lines covering four entities
(invoice, sale_line, quote, quote_line) and two printable reports;
`propertymanagement/views/PropertyManagementViews.ts` reached 708 lines covering six entities
and one report. Finding "the quote workflow" or "the rent receipt report" meant scrolling a
single large file mixing unrelated entities' fields, behaviors, and route wiring, with no
file-system structure mirroring the actual data model. The user asked for a straightforward
split: one file per DB model, named `<model>_views.ts`; one file per report, named
`<report>_report.ts`, in a `reports/` folder at the same level as `views/`; `module.json`
updated to match.

**A real engine constraint surfaced before any file could move.** `ModuleRegistry.register()`
(`core-front/packages/core-front/src/registry/registry.ts`) is **idempotent by module name** —
a second `register()` call under a name already seen is silently *skipped*, not merged:

```ts
if (this.entries.some((e) => e.module.name === module.name)) return this
```

So a naive split — each entity's file independently calling `moduleRegistry.register()` with
the same module name — would silently drop every entity past the first one discovered. Two
architectures were weighed (see the conversation's own clarifying question): change the
registry to merge same-name registrations across files, or keep exactly one file per module
responsible for registration and let every other file export plain, non-registering pieces.
The second was chosen — zero engine behavior change, ships without touching `registry.ts` or
any other module's discovery contract.

## Decision

### 1. One `<model>_views.ts` per owned entity, one `reports/<name>_report.ts` per report

Each entity a module owns gets its own file under `views/`: the entity's TypeScript interface,
`ViewDescriptor`s (dashboard/list/form), `registerFieldFunction`/`registerOnChange`/
`registerHeaderButtonAction`/`registerMenuAction` calls (side-effect registrations, unchanged —
still fire at import time), and any view-extension `Operation[]` the entity's own form needs.
Each `ReportDescriptor` gets its own file under a **`reports/` folder that is a sibling of
`views/`**, not nested inside it (`core/modules/<name>/reports/`, alongside `core/modules/<name>/views/`) —
the same level `i18n/` already sits at next to `views/`.

### 2. Exactly one file per module still default-exports the `FrontModule` — the assembler

A module with more than one owned entity (or one entity plus a report) gets a thin assembler
file, `<module>_views.ts`, that imports the routes/pieces each entity file exports and combines
them into the single `FrontModule` object `module.json`'s `static_files.views` lists — the
*only* file this codebase's discovery script (`module-discovery.mjs`) ever imports for that
module. Every entity/report file is reached from there by an ordinary ES import, invisible to
discovery. `core/modules/sale/views/sale_views.ts` is the reference shape:

```ts
import { dashboardRoute, invoiceRoutes, orderLinesPageOperations } from './invoice_views'
import { quoteRoutes, quoteLinesPageOperations } from './quote_views'
import { saleLineRoutes } from './sale_line_views'
import { quoteLineRoutes } from './quote_line_views'
import { invoiceReport } from '../reports/invoice_report'
import { quoteReport } from '../reports/quote_report'

const sale: FrontModule = {
  name: 'sale',
  routes: [dashboardRoute, ...quoteRoutes, ...quoteLineRoutes, ...invoiceRoutes, ...saleLineRoutes],
  reports: [invoiceReport, quoteReport],
  extends: [
    { path: '/sale/:id', operations: orderLinesPageOperations },
    { path: '/sale/quote/:id', operations: quoteLinesPageOperations },
  ],
}
export default sale
```

### 3. Two naming resolutions for edge cases, applied consistently across every module

- **A module with exactly one owned entity** (`crm`, `contact`, `appstore`'s `modules` virtual
  entity) skips the separate assembler file entirely — nothing else needs assembling, so the
  one `<model>_views.ts` file both declares the entity's pieces *and* default-exports the
  `FrontModule`, importing straight from `../reports/` itself when the module has a report
  (`crm_views.ts` imports `../reports/statement_report.ts` this way).
- **A module whose name collides with one of its own entity names** (`cron`'s `cron` entity,
  alongside `cron_history`) lets that entity's own file double as the assembler, importing the
  other entities' route exports — the alternative (two files both wanting to be named
  `cron_views.ts`) isn't spellable.
- A module owning **zero entities** (`crminheritdemo`, a pure view-extension module —
  `routes: []`) has no model to name a file after, so its one file is named after the module
  itself.

### 4. Route order across files must reconstruct the original order exactly

`Menu.tsx` links a module's landing tile to `module.routes[0].path`, and
`ModuleRegistry.listViews()`/`menu()` read `module.routes` **in declaration order** to decide
dashboard-tile and menu ordering (a module's tree views roll into count-tiles in the order
they appear in `routes`). Naively spreading each entity file's route array in whatever order
the assembler happens to import them would silently reorder — or, worse, change which route the
module's own landing tile opens. Every assembler pulls the dashboard route out into its own
export (`dashboardRoute`, forced first) and preserves each entity's original relative route
order (e.g. `quoteRoutes` still registers ahead of `invoiceRoutes`, matching the pre-split file,
because `warehouse`'s and `sale`'s own doc comments already documented *why* that order
produces the first dashboard tile).

## Consequences

- A new entity added to an existing module is a new `<model>_views.ts` file plus one import line
  in the module's assembler — never appended to a growing shared file.
- `module.json`'s `static_files.views` names only the assembler; adding an entity/report file
  never touches `module.json`.
- Every module's own test file stays one combined `<assembler>_views.test.ts` — the split
  applies to source structure, not test structure; splitting tests per entity was explicitly
  out of scope.
- Any future module scaffolded by `tools/eerp-init-module` should start in this shape directly
  (one entity file + assembler, even for a single entity, growing into the multi-file shape
  the moment a second entity or a report is added) rather than starting as one large file and
  needing this exact migration again.
- `core-front/CLAUDE.md`'s "Module discovery" section documents the convention and both naming
  resolutions as the living reference; this ADR is the historical decision record.

## Reference implementation

`core/modules/sale/` (`views/sale_views.ts` assembler + `invoice_views.ts`/`sale_line_views.ts`/
`quote_views.ts`/`quote_line_views.ts` + `reports/invoice_report.ts`/`reports/quote_report.ts`) —
the pattern this ADR names, applied identically across `core/modules/{crm,contact,appstore,
crminheritdemo,cron,propertymanagement,warehouse}/`. `core-front/packages/core-front/src/
registry/registry.ts` (`ModuleRegistry.register()`'s idempotent-by-name contract, unchanged —
the reason an assembler file exists at all). `core-front/CLAUDE.md`'s "Module discovery"
section.
