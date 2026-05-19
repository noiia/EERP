# SKILLS.md

## Purpose

Compact reusable workflows. Each skill: one problem class, deterministic output, minimal reasoning overhead, implementation-ready.

**Rule**: Reuse the matching skill immediately. Never re-derive its workflow.

---

## Skill Index

| Skill | Trigger |
|---|---|
| `go_api_endpoint` | CRUD, REST handlers, DTO, validation |
| `postgres_query_optimization` | Slow queries, indexes, EXPLAIN ANALYZE, locks |
| `go_orm_generation` | Query builders, model metadata, SQL gen |
| `migration_generation` | Schema changes, index changes, data migrations |
| `docker_optimization` | Dockerfiles, image size, multi-stage, CI |
| `kubernetes_deployment` | Deployments, services, ingress, PVs, Longhorn |
| `concurrency_debugging` | Race conditions, deadlocks, goroutine leaks |
| `benchmark_analysis` | Perf regressions, allocations, latency, throughput |
| `frontend_component_generation` | React/MUI components, forms, tables, dashboards |
| `architectural_review` | Large refactors, service boundaries, ORM design ⚠️ powerful model |
| `test_generation` | Unit, integration, benchmarks |
| `security_review` | Auth, secrets, multi-tenant, WASM sandboxing ⚠️ powerful model |
| `repository_context_compression` | Token overflow, context summarization |

---

## Skill: go_api_endpoint

**Input**: endpoint spec (method, path, handler, DTO, validation rules)
**Output**: modified handler + route registration + optional test

Rules:
- Return only modified files
- Match existing repository patterns
- No tutorial comments

---

## Skill: postgres_query_optimization

**Input**: slow query + EXPLAIN ANALYZE output (if available)
**Output**:
1. Root cause
2. Proposed SQL / index
3. Expected impact
4. Risk level

Mandatory checks: existing indexes, cardinality, sequential scans, join selectivity, transaction scope, connection usage.

---

## Skill: go_orm_generation

**Input**: feature spec (builder extension, model, SQL pattern)
**Output**: implementation file(s) + updated tests

Rules:
- pgx v5 only, no `database/sql`
- No reflection in hot paths
- `reflect.VisibleFields()` for struct introspection
- `IndexPath []int` in `FieldMeta`
- Immutable builders, `$N` rebasing
- Allocations minimized

---

## Skill: migration_generation

**Input**: schema change description
**Output**: up migration + down migration + risk note

Rules:
- `CONCURRENTLY` for indexes on large tables
- Avoid `ACCESS EXCLUSIVE` on hot tables
- State rollback safety explicitly
- One sentence risk assessment

---

## Skill: docker_optimization

**Input**: existing Dockerfile or target binary description
**Output**: optimized Dockerfile diff

Rules:
- Multi-stage, distroless/static final image
- Minimize layers
- Cache `go mod download` before `COPY .`
- No unnecessary runtime packages

---

## Skill: kubernetes_deployment

**Input**: service description + resource requirements
**Output**: Deployment + Service YAML (+ Ingress / PVC if needed)

Rules:
- `readinessProbe` + `livenessProbe` mandatory
- `resources.requests` + `resources.limits` required
- Longhorn StorageClass for persistent volumes
- No unnecessary complexity

---

## Skill: concurrency_debugging

**Input**: code + observed symptom (race, deadlock, leak)
**Output**: root cause + fix diff

Required analysis: ownership model, lock ordering, context cancellation, memory visibility, channel lifecycle.

---

## Skill: benchmark_analysis

**Input**: benchmark output (`go test -bench` or pprof)
**Output**: bottleneck + fix + expected delta

Priority order: allocations → p95 latency → throughput → CPU → memory.

---

## Skill: frontend_component_generation

**Input**: component spec (purpose, data shape, interactions)
**Output**: functional React component (MUI)

Rules:
- Functional components only
- Localized state
- No over-abstraction
- Accessibility (aria labels, keyboard nav)

---

## Skill: architectural_review ⚠️ Powerful model

**Input**: system description + change proposal
**Output**:
1. Constraints
2. Risks
3. Recommended approach
4. Tradeoffs
5. Migration path

---

## Skill: test_generation

**Input**: target function/package + test type (unit / integration / benchmark)
**Output**: test file or diff

Rules:
- Table-driven tests
- Unit tests: mock executor, no DB
- Integration tests: `//go:build integration`, `TEST_DSN`
- Test observable behavior, minimize mocks
- Always update tests when source changes

---

## Skill: security_review ⚠️ Powerful model

**Input**: code or design under review
**Output**: findings list + severity + fix per finding

Mandatory checks: injection, privilege escalation, secret exposure, isolation boundaries, unsafe deserialization.

---

## Skill: repository_context_compression

**Input**: current conversation / context
**Output**: compressed bullet summary

Rules:
- Keep: active decisions, unresolved blockers, current file paths
- Drop: resolved discussions, repeated context, verbose explanations
- Format: bullets only

---

## Workflow

**Default**:
1. Match skill → apply immediately
2. Lightweight model executes
3. Return minimal implementation
4. Escalate only if blocked (see CLAUDE.md triggers)

**Post-escalation**:
1. Summarize findings in ≤5 bullets
2. Return to lightweight model

---

## Final Principle

Every generated token must: reduce engineering time, reduce risk, improve correctness, improve performance, or improve maintainability. Otherwise omit it.
