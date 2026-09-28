package handler_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"core/orm"
	"core/orm/access"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// TestIntegration_ReadCache proves the optional Redis cache (ADR-022) serves
// generic list/get reads and that every write path through *orm.DB — plain
// Exec, INSERT ... RETURNING via QueryRow, and a transaction — invalidates it.
func TestIntegration_ReadCache(t *testing.T) {
	url := os.Getenv("REDIS_URL")
	if url == "" {
		t.Skip("REDIS_URL not set — skipping Redis-backed test")
	}
	app, e := setupIntegration(t)
	ctx := context.Background()
	qc, err := orm.NewQueryCache(ctx, url, 0)
	if err != nil {
		t.Fatalf("connect redis: %v", err)
	}
	app.DB.SetQueryCache(qc)
	t.Cleanup(func() {
		app.DB.SetQueryCache(nil)
		_ = qc.Close()
	})

	tenant := uuid.New() // own tenant: only this test's rows are visible
	get := func(path string) (int, string) {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req = req.WithContext(access.WithTenant(req.Context(), tenant))
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s: %d %s", path, rec.Code, rec.Body)
		}
		var body struct {
			Total int `json:"total"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		return body.Total, rec.Body.String()
	}
	insert := func(name string) uuid.UUID {
		var id uuid.UUID
		if err := app.DB.QueryRow(ctx,
			"INSERT INTO test_items (tenant_id, name) VALUES ($1, $2) RETURNING id", tenant, name).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}

	id := insert("alpha") // QueryRow + RETURNING
	total, first := get("/api/v1/test_items")
	if total != 1 {
		t.Fatalf("total = %d, want 1", total)
	}
	if _, second := get("/api/v1/test_items"); second != first {
		t.Fatalf("a cache hit must render byte-identical JSON:\n%s\n%s", first, second)
	}

	// A write that bypasses *orm.DB is invisible until TTL — proof the read above
	// really came from Redis rather than Postgres.
	if _, err := app.DB.Pool().Exec(ctx, "INSERT INTO test_items (tenant_id, name) VALUES ($1, 'ghost')", tenant); err != nil {
		t.Fatal(err)
	}
	if total, _ := get("/api/v1/test_items"); total != 1 {
		t.Fatalf("total = %d, want the cached 1", total)
	}

	// Plain Exec through *orm.DB invalidates.
	if _, err := app.DB.Exec(ctx, "UPDATE test_items SET name = 'beta' WHERE id = $1", id); err != nil {
		t.Fatal(err)
	}
	if total, _ := get("/api/v1/test_items"); total != 2 {
		t.Fatalf("after Exec: total = %d, want 2", total)
	}

	// A transaction invalidates on commit.
	_, before := get("/api/v1/test_items/" + id.String())
	if err := app.DB.Transaction(ctx, func(tx *orm.Tx) error {
		_, err := tx.Exec(ctx, "UPDATE test_items SET name = 'gamma' WHERE id = $1", id)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if _, after := get("/api/v1/test_items/" + id.String()); after == before {
		t.Fatalf("GET by id still serves the pre-transaction row: %s", after)
	}

	// Query with RETURNING invalidates once drained.
	rows, err := app.DB.Query(ctx, "INSERT INTO test_items (tenant_id, name) VALUES ($1, 'delta') RETURNING id", tenant)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID]); err != nil {
		t.Fatal(err)
	}
	if total, _ := get("/api/v1/test_items"); total != 3 {
		t.Fatalf("after Query RETURNING: total = %d, want 3", total)
	}
}
