# ORM — Claude reference

## Running tests

```bash
make run-back-tests   # docker compose up -d && cd core && go test ./...
```

Always use this command — it starts the DB container before running tests, so integration tests have a live PostgreSQL available.

Root: `core/orm/` · Import path: `github.com/erp/orm` (alias via `core/orm`)

## Layer map & file ownership

```
orm.go                ← single import surface; type aliases + thin wrappers only
pool/config/config.go ← Config struct + Validate() + withDefaults()
pool/db/db.go         ← *DB (pgxpool wrapper): Open, Query, QueryRow, Exec, Transaction
pool/tx/tx.go         ← *Tx: same Executor + Savepoint/RollbackTo/Release
pool/executor/        ← Executor interface (Query/QueryRow/Exec) + TxBeginner
internal/cache/       ← StructMeta + MetadataCache (sync.Map); built once via reflect.VisibleFields
internal/scan/        ← Rows[T] (name-mapped) + Row[T] (positional) + assignToField
model/base.go         ← BaseModel (id pk, created_at immutable, updated_at, deleted_at softdelete)
model/entity.go       ← Entity constraint (= any; enforced at runtime by cache, not by the type system)
query/condition.go    ← Condition + NewCondition + rebase() + whereClause() + placeholders()
query/select.go       ← SelectBuilder[T]: Where/Join/OrderBy/Limit/Offset/Columns → ToSQL/All/One
query/insert.go       ← InsertBuilder[T]: Returning → ToSQL/One/Batch/Exec
query/update.go       ← UpdateBuilder[T]: FromStruct/Set/Where/Returning → ToSQL/Exec/One/All
query/delete.go       ← DeleteBuilder[T]: Where/Returning → ToSQL/Exec/One/All
query/upsert.go       ← UpsertBuilder[T]: OnConflict/DoUpdate/DoUpdateSet/DoNothing → ToSQL/One/Batch/Exec
repo/repository.go    ← Repository[T]: FindByID/FindAll/FindAllWithDeleted/Query/Create/Update/Delete/HardDelete/Restore/DeleteWhere/CreateBatch/WithTx
```

## Invariants — never break these

- **Immutable builders.** Every method on SelectBuilder/InsertBuilder/UpdateBuilder/DeleteBuilder/UpsertBuilder copies the slice before appending (`append(append([]T{}, old...), new...)`). Never mutate a field in-place.
- **WHERE required on UPDATE and DELETE.** `UpdateBuilder.ToSQL()` and `DeleteBuilder.ToSQL()` return an error when `wheres` is empty. Repo methods that need a full-table pass are not supported by design.
- **PK and soft-delete columns are Immutable.** `UpdateBuilder.FromStruct` skips any field with `f.Immutable == true`. The `pk`, `softdelete`, and `immutable` tags all set `FieldMeta.Immutable = true`.
- **Soft-delete guard in repo.** `FindByID`, `FindAll`, `Update`, and `Delete` (soft path) all inject `deleted_at IS NULL`. `FindAllWithDeleted` and `HardDelete` do not.
- **Executor is the seam.** Every builder execution method takes `executor.Executor`. Pass a `*DB` or a `*Tx` — both satisfy the interface.
- **Zero reflection after repo construction.** `cache.Get[T]()` is called once in `repo.New[T]`. All subsequent operations use the cached `StructMeta`.
- **`reflect.VisibleFields` for embedded structs.** `cache.build()` uses `reflect.VisibleFields(t)`, not `t.NumField()`. This is what correctly resolves promoted fields from `BaseModel`. Do not change this.
- **Scan always into `*any`.** `scan.Rows` and `scan.Row` scan into `[]any` of `*any` pointers. pgx writes the decoded native Go value; `assignToField` then copies into the struct via reflect. This avoids OID/format mismatches entirely.
- **`Row` is positional, `Rows` is name-mapped.** `scan.Row` assumes the SQL returns columns in `meta.Fields` order. All ORM-generated SQL (Insert/Update RETURNING, QueryRow-based paths) lists columns explicitly in that order. `scan.Rows` uses `FieldDescriptions()` and is order-independent.
- **`QueryExecModeDescribeExec` is required.** Set in `db.Open` to prevent corrupted TIMESTAMPTZ decoding under `QueryExecModeCacheDescribe`. Do not change the exec mode.
- **Timestamp codec registration.** `AfterConnect` in `db.Open` registers `TimestamptzCodec` and `TimestampCodec` explicitly. Required for `time.Time` decoding; must run on every new connection.

## Struct tag cheat sheet

| Tag | Effect on FieldMeta |
|-----|-------------------|
| `db:"col"` | Column = "col" |
| `db:"col,pk"` | IsPK=true, Immutable=true — excluded from INSERT (PK col) and UPDATE SET |
| `db:"col,immutable"` | Immutable=true — excluded from UPDATE SET (use for created_at) |
| `db:"col,softdelete"` | SoftDel=true, Immutable=true — managed by repo only; nil=active |
| `db:"col,omitempty"` | OmitEmpty=true — skip field in FromStruct if zero |
| `db:"-"` | Ignored entirely |
| _(no tag)_ | Column = toSnake(FieldName) |

`InsertBuilder.effectiveCols()` also skips `time.Time` zero values to let PostgreSQL `DEFAULT now()` fire for `created_at`/`updated_at`.

## Condition / arg rebasing

`NewCondition("col = $1", val)` always uses `$1`-based numbering. `whereClause()` calls `c.rebase(offset)` to rewrite `$N → $offset+N-1`. Walk backwards to avoid partial rewrites of `$10` before `$1`.

`UpdateBuilder.ToSQL()` numbers SET args first (`$1..$N`), then rebases WHERE conditions starting at `$N+1`.

## Upsert-specific rules

- `OnConflict()` is required — missing it returns an error from `ToSQL()`.
- `DoUpdate()` (no args) updates all writable columns except the conflict columns themselves.
- `DoUpdateSet(cols...)` updates only the named columns — use for partial upserts where ownership/audit columns must not be overwritten.
- Uses `WritableColumns()` (non-PK) for the VALUES clause, not `effectiveCols()` — zero timestamps are not skipped.

## `hardDelete` bypasses builders

`repo.hardDelete` uses a raw `fmt.Sprintf` for the DELETE SQL. If you need `RETURNING` on a hard delete, use `query.Delete[T]` directly from the call site, not via the repo.

## Savepoints

`Tx` exposes `Savepoint(name)` / `RollbackTo(name)` / `Release(name)`. `PgxSafeName` strips non-`[a-zA-Z0-9_]` chars to prevent SQL injection in savepoint names. Always use it when constructing savepoint SQL.

## Config defaults

| Field | Default |
|---|---|
| MaxConns | 10 |
| MinConns | 2 |
| MaxConnIdleTime | 30 min |
| MaxConnLifeTime | 1 hour |
| HealthCheckPeriod | 1 min |
| ConnectTimeout | 10 s |

`withDefaults()` mutates in place and is called inside `Validate()`.

## Testing conventions

- **Unit tests** live alongside source (`_test.go` in same package or `_test` external package). They use a `mockExecutor` that captures `lastSQL`/`lastArgs`. No live DB.
- **Integration tests** use `//go:build integration` + `TEST_DSN` env var. Run with `-tags=integration`. They create real tables, use `t.Cleanup` to drop them, and call `openIntegrationDB()` which skips if `TEST_DSN` is unset.
- Test fixtures use plain structs with `db` tags — not `model.BaseModel` — so they can verify the cache/scanner in isolation.
- `assertContains(t, sql, substr)` / `assertNotContains` are the standard SQL assertion helpers in `query_test.go`. `assertSQL` / `assertNotSQL` are the equivalents in `repo_test.go`.
- Every builder test verifies immutability: derive two builders from a base and assert neither affects the other.

## Where to add new things

| Task | Where |
|---|---|
| New query method | Add to the relevant `*Builder` in `query/`; method must return a new copy |
| New repo CRUD method | Add to `repo/repository.go`; delegate to query builders |
| New struct tag modifier | `cache/meta.go` → `parseField()`; add `FieldMeta` field; update `cache/cache.go` if needed |
| New scan type coercion | `scan/scan.go` → `assignToField()` |
| New pool option | `pool/config/config.go` → `Config` + `Validate()` + `withDefaults()`; wire in `db.Open()` |
| New executor method | Add to `executor.Executor` interface + implement on `*DB` and `*Tx` |

## Common pitfalls

- `scan.Row` (positional) is only correct when the SQL lists columns in `meta.Fields` order. `RETURNING *` may not match — use explicit `RETURNING col1, col2...` or switch to `scan.RowFromRows` (uses `Query` path with `FieldDescriptions`).
- `UpdateBuilder.FromStruct` followed by `Set("col", val)` deduplicates: the last `Set` call for a given column wins. PostgreSQL rejects duplicate column assignments (`SQLSTATE 42601`).
- `Upsert.DoUpdate()` excludes conflict columns from the SET clause automatically. `DoUpdateSet(cols...)` does not do this — you are responsible for not listing the conflict column.
- `pluralize()` always applies — including to already-plural names. Use `Tabler` (`TableName() string`) on structs with irregular or pre-plural names.
- `TxBeginner` is separate from `Executor` so `*Tx` cannot call `Transaction()` on itself. Nested transactions must use savepoints.
- Debug logging is gated on `config.Debug || err != nil`. Zero-overhead in production with `Debug: false`.
