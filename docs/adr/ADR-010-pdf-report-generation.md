# ADR-010: PDF report generation — external Chromium-backed service, descriptor-driven reports

**Status:** Accepted

## Context

The ERP needs server-generated PDF reports (statements, invoices, list exports), authored the
same way developers already author on-screen views — declarative descriptors, not a bespoke
templating language — with real CSS (Tailwind/MUI) styling freedom and reuse of the exact
component/data model forms already use. New devs should not need a second mental model to
build a report versus a view.

Three architectures were benchmarked directly on real hardware (not vendor claims), generating
the same 250-row / ~7-page statement report:

| | Go-native (`go-pdf/fpdf`, in-process) | Typst (Rust CLI, `typst compile`) | Headless Chromium (`chromedp`, proxy for Puppeteer/Playwright/Gotenberg) |
|---|---|---|---|
| Cold single call | 11.4ms mean | 267.5ms mean | 493ms (fresh browser) |
| Warm/pooled single call | n/a — stateless | not applicable to CLI usage | 173ms (pooled browser, new tab) |
| Concurrency throughput | 873 reports/s @ 200 goroutines (16 cores, in-process) | 19.9 reports/s @ 8 concurrent subprocesses | 19.3-22.5 reports/s @ 8-20 concurrent tabs on 16 cores; **~3.2 reports/s per vCPU** measured at 2 and 4 vCPU (plateaus past ~2× core count concurrency) |
| Memory | ~11MB/call | ~53MB/call | ~150-190MB per browser instance |
| Output size | 23KB | 340KB (embeds font subset) | 57KB |

`wkhtmltopdf` was excluded outright: archived/abandoned since January 2023, an unpatched
CVSS 9.8 SSRF (CVE-2022-35583), and a ~2012-era CSS engine with no Flexbox/Grid support.

Go-native wins raw throughput and memory by 1-2 orders of magnitude and needs no extra
service. But it has no CSS box model — "Tailwind class" and "move any element" have no
meaning to a cell/grid PDF library. Reaching that requires designing and permanently owning a
custom layout engine, which trades a large, open-ended maintenance burden for *less*
flexibility than the product requirement calls for, not more. Typst sits in between
(excellent typography, real pagination primitives) but is authored in its own markup
language, not TS, and would be the first Rust code anywhere in this Go-only backend (the
"WASM modules" are themselves Go, compiled to `wasip1` — there is no Rust in this codebase
today despite older docs suggesting otherwise).

Headless Chromium's absolute throughput easily covers realistic ERP volumes even though its
per-vCPU number is far behind native Go: a 4-vCPU replica sustains ~13 reports/s; five
replicas clear a 10,000-report month-end batch inside a 10-minute window (~16.7/s needed)
with headroom, and scaling is linear via replica count since each Chrome instance is
independent. The per-vCPU ceiling is identical whether Chromium runs embedded in the core API
process or in a separate service — what differs is *what that CPU budget competes with*.
Embedded, a report burst directly raises core API latency and a Chromium hang/zombie process
shares the API's fault domain; externalized, neither risk touches the API.

Chromium's usual attack-surface objection is blunted here by the threat model: the renderer
only ever navigates to URLs it (or the trusted core) constructs itself, pointing at an
internal, network-isolated core-front route — never an attacker-supplied URL or untrusted
HTML, which is what most real-world Chromium-PDF CVEs actually exploit.

## Decisions

### 1. Render engine: headless Chromium (`chromedp`), not a native Go or Rust renderer

Chosen for CSS/Tailwind/MUI fidelity and direct reuse of existing React components and form
data — the explicit product requirement — accepting the throughput/memory cost documented
above as bounded and, per the sizing above, not an actual bottleneck for this domain.

### 2. Deployment shape: standalone Go microservice (`pdf-service`), not embedded in core

Isolates Chromium's resource and fault domain from the API server. Runs alongside `core` as
its own container (own health check, own restart policy, own image — the ~300-400MB Chromium
footprint never lands in the core image or its deploy path).

### 3. Transport v1: synchronous HTTP; NATS is a pre-wired, deferred extension point

The service exposes `POST /render` and returns PDF bytes directly for v1 — no message broker
required to ship. The renderer itself sits behind a small `Renderer` interface
(`Render(ctx, RenderRequest) ([]byte, error)`) so a NATS `QueueSubscribe` front door can be
added later purely as a second transport calling the same interface — multiple replicas then
form a competing-consumer group for free, with zero change to render logic. Not built until
multiple workers are actually needed (YAGNI) — see Phase 5 in the roadmap.

### 4. Report authoring: declarative `ReportDescriptor`, not hand-written pages, not XML

Mirrors the existing `ViewDescriptor`/`FrontModule` "descriptors only" contract: a `layout`
tree of typed nodes (section/table/field), each carrying an optional `className` for
Tailwind/MUI styling, bound to the same entity field data forms already use. A single generic
print route interprets any `ReportDescriptor` into DOM, exactly as `FormRenderer` already
interprets `ViewDescriptor`. TS/JSON is the only format — no parallel XML schema/parser,
avoiding a second report-definition language for no demonstrated interop need.

### 5. Delivery: upload to Garage (S3-compatible), mirroring `internal/pictures`

For v1, `POST /render`'s response bytes are acceptable to return inline (reports are modest
KB-scale). The core-side handler uploads the result to Garage using the same object-storage
split `internal/pictures` already established (metadata row, bytes in S3) rather than storing
PDFs in Postgres, and hands the client a download URL. Revisit inline bytes if report sizes
grow enough to matter.

### 6. Pagination: DevTools `Page.printToPDF` header/footer templates, not CSS `running()`

Chromium supports `@page` margin boxes and `counter(page)`/`counter(pages)` since Chromium
131+, which covers page numbers, static titles, and dates — confirmed working in
benchmarking via `headerTemplate`/`footerTemplate`. CSS `running()` (dynamic per-page content
migrating from the body into a margin box, e.g. "repeat the current section name") is *not*
supported by Chromium and is a known, documented limitation, not a bug to chase.

## Consequences

- New service in the deployment topology: `compose.yml` gains a `pdf-service` entry; Chromium
  version/security patching becomes an explicit operational responsibility (mitigated by the
  narrow internal-only navigation surface and the service's small, independent blast radius).
- Report authors write `ReportDescriptor`s with real CSS classes — the same skillset as
  writing a view, which was the whole point.
- Throughput scales via replica count past roughly 2× a single instance's vCPU count in
  concurrent tabs, not by raising per-instance concurrency further — capacity planning must
  add replicas, not just raise a concurrency knob.
- NATS integration is explicitly deferred but pre-wired (`Renderer` interface) — adding it
  later touches only the transport, never the render path.

## Reference implementation

See `docs/roadmaps/pdf-reports.md` for the phased build plan. A working, benchmarked
`chromedp`-based renderer + HTTP handler (pooled browser, tab-per-report, header/footer page
numbers) was prototyped and load-tested during this ADR's research; Phase 1 formalizes it into
`tools/pdf-service` (or wherever the roadmap lands it) with tests.
