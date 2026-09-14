# ADR-017: HTTP/2 at the gateway edge, and batching over adopting GraphQL

**Status:** Accepted

## Context

Two independent pieces of work landed back to back on 2026-08-21 and both bear on the same
underlying question: this app's forms fire a lot of small relation-fetch requests (tags,
contacts, any many2many), and every entity list is a REST resource under
`GET /api/v1/{table}`. The question the pair of changes together settles is whether that
call shape needs a different transport (HTTP/2 multiplexing) or a different API paradigm
(GraphQL, so a form could ask for a record plus its relations in one round trip) — or whether
the existing REST + generic-CRUD surface can absorb the cost with a smaller, local fix.

**The N+1 side:** `RelationTagsWidget` and `relation-summary-widget`'s nested m2m resolver
(`loadSubRelation`) each fetched their junction rows' related records with one `ops.get()` call
per row — a form with a handful of linked tags/contacts fired that many extra sequential round
trips on mount. This is the textbook case GraphQL's field-graph resolution is pitched at solving:
ask for `record { tags { name } }` once, let the server fan out server-side.

**The transport side:** the api-gateway (`infra/nginx/nginx.conf`) had an HTTPS server block
already drafted but commented out. Enabling it was verified empirically first: Node's `undici`
fetch does **not** speak cleartext h2c (silently stays on HTTP/1.1 even with an `allowH2`
dispatcher against a working h2c server) — HTTP/2 only works over TLS in practice. Since the
browser is the only real "client" in this BFF architecture (it never talks to Go directly,
always through Next's route handlers), that's also the only hop worth paying the TLS complexity
for. HTTP/2 buys connection multiplexing: many small requests over one connection instead of
one connection (or HTTP/1.1's limited parallel-connection pool) per request.

## Decision

### 1. Fix the N+1 by batching the existing REST list endpoint, not by adding GraphQL

`resolveManyToManyLinks` (`core-front/packages/core-front/src/views/relation-widgets.tsx`)
replaces the per-row `ops.get()` fan-out with junction list + **one** batched
`ops.list(relatedEntity, { in: { id: [...] } })` call regardless of row count — reusing the
generic list endpoint's existing `in[column]` filter (`core/orm`, see CLAUDE.md's ORM section).
No backend change was needed: the filter already existed for exactly this shape of query. Both
`RelationTagsWidget` and `relation-summary-widget` now share the one helper instead of
duplicating the fan-out pattern, and the dangling-junction fallback (a deleted related record
keeps its id as a placeholder label) is preserved.

This is deliberately the REST answer to a problem GraphQL is usually reached for: one query
parameter (`in[id]`) collapses N requests to 1, without a new query language, a new endpoint
shape, or a resolver/schema layer on top of the generic CRUD surface every other entity already
gets for free. The carousel widget's per-slide picture metadata lookup is a *different* N+1
shape (one anchor per binary resource, no existing batch endpoint on `internal/pictures`) and
was left for a separate change — not folded into this one.

### 2. HTTP/2 lands at the gateway edge only, TLS-gated, no app code changes

`infra/nginx/nginx.conf`'s HTTPS server block is enabled (self-signed dev cert via
`infra/nginx/gen-certs.sh` + a `gateway-certs` one-shot compose service that provisions it into a
shared volume before nginx starts, idempotent — same "no missing-piece surprise" posture
`pdf-service` already takes in `compose.yml`). Plain `http://localhost/` (:80) now 301-redirects
everything except `/healthz` to `https://localhost/` (:443) — serving the app over plain HTTP
would silently break login once Secure cookies are the default, so upgrading the redirect is
safer than leaving both paths "working" with different behavior. `core-front`'s
`COOKIE_SECURE: "false"` override is dropped now that TLS is actually terminated, restoring its
`NODE_ENV=production` default. Next↔Go stays plain HTTP/1.1 internally, untouched — the only hop
that benefits from multiplexing is the one with many small parallel requests (the browser making
relation/widget calls), not the single BFF↔backend hop.

### 3. REST + HTTP/2 multiplexing over REST + GraphQL, for this codebase's shape

Put together, the two changes are the answer to "should we adopt GraphQL": no, not yet, because
the two real motivations for it — collapsing N+1 fan-out, and avoiding head-of-line blocking on
many small parallel requests — are each already covered by a smaller, local fix (`in[column]`
batching; HTTP/2 multiplexing at the edge). GraphQL would additionally cost a schema/resolver
layer duplicating what `core/orm`'s generic CRUD surface + `ViewDescriptor` engine already derive
automatically for every entity (List/Kanban/Calendar/Graph, field-level group gating per
ADR-013, structured filters per ADR-014) — none of which has a GraphQL equivalent in this
codebase today. Revisit only if a genuinely graph-shaped query need shows up that `in[column]`
batching + client-side composition can't express reasonably (e.g., deep, variably-shaped
nested fetches that would need per-case batching helpers each time).

## Consequences

- Every future many2many/relation resolver should reuse `resolveManyToManyLinks` rather than
  reintroducing a per-row fan-out — the pattern (junction list + one `in[column]` batch) applies
  wherever a set of related records needs to be resolved from a set of ids.
- The carousel widget's picture-metadata N+1 is still open; fixing it needs a batch endpoint on
  `internal/pictures` that doesn't exist yet (tracked, not built here).
- HTTP/2 is real only at the browser↔gateway hop; profiling internal BFF↔Go latency won't see
  any change from this work, and shouldn't be expected to.
- The REST-over-GraphQL call isn't a permanent rule — it's scoped to the query shapes this
  codebase has needed so far. A future feature with genuinely graph-shaped fetch requirements
  should reopen this ADR rather than accumulate ad hoc batching helpers past the point they stay
  simpler than a resolver layer.

## Reference implementation

`core-front/packages/core-front/src/views/relation-widgets.tsx` (`resolveManyToManyLinks`),
`core-front/packages/core-front/src/views/relation-summary-widget.tsx`, `core/orm` (`in[column]`
filter, see CLAUDE.md's ORM section), `infra/nginx/nginx.conf`, `infra/nginx/gen-certs.sh`,
`compose.yml` (`gateway-certs` service), `core-front` (`COOKIE_SECURE` env var removal).
