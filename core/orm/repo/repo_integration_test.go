package repo_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"core/internal/common"
	"core/internal/types"
	"core/orm"
	"core/orm/model"
	"core/orm/query"

	"github.com/google/uuid"
)

// ── Test entities ─────────────────────────────────────────────────────────────

type test_product struct {
	model.BaseModel
	Name     string `db:"name"`
	Price    int    `db:"price"`
	Category string `db:"category"`
}

// TableName pins the table name to exactly what setupProductTable creates.
// Without this, pluralize(toSnake("test_product")) = "test_products" ≠ "test_product".
func (test_product) TableName() string { return "test_product" }

type hardProduct struct {
	ID    uuid.UUID `db:"id,pk"`
	Label string    `db:"label"`
}

func (hardProduct) TableName() string { return "hard_product" }

// ── Helpers ───────────────────────────────────────────────────────────────────

func integrationDSN(t *testing.T) string {
	t.Helper()
	configFile := os.Getenv("CONFIG")
	configContent, err := common.DecodeJSON[*types.Config](configFile)
	if err != nil {
		t.Error("❌ Error reading config file:", err)
	}
	dsn := fmt.Sprintf("postgres://%s:%s@%s:%d/%s",
		configContent.DbUser, configContent.DbPassword,
		configContent.DbHost, configContent.DbPort, configContent.DbName)
	if dsn == "" {
		t.Skip("DSN not set — skipping integration test")
	}
	return dsn
}

func openIntegrationDB(t *testing.T) *orm.DB {
	t.Helper()
	db, err := orm.Open(context.Background(), orm.Config{
		DSN:      integrationDSN(t),
		Debug:    true,
		MaxConns: 1,
	})
	if err != nil {
		t.Fatalf("orm.Open: %v", err)
	}
	t.Cleanup(db.Close)
	return db
}

func setupProductTable(t *testing.T, db *orm.DB) {
	t.Helper()
	ctx := context.Background()
	_, err := db.Exec(ctx, `
		CREATE TEMP TABLE IF NOT EXISTS test_product (
			id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
			name        TEXT        NOT NULL,
			price       INT         NOT NULL DEFAULT 0,
			category    TEXT        NOT NULL DEFAULT '',
			created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
			updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
			deleted_at  TIMESTAMPTZ
		)
	`)
	if err != nil {
		t.Fatalf("create temp table: %v", err)
	}
	t.Cleanup(func() {
		db.Exec(ctx, `DROP TABLE IF EXISTS test_product`)
	})
}

func setupHardTable(t *testing.T, db *orm.DB) {
	t.Helper()
	ctx := context.Background()
	_, err := db.Exec(ctx, `
		CREATE TEMP TABLE IF NOT EXISTS hard_product (
			id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			label TEXT NOT NULL
		)
	`)
	if err != nil {
		t.Fatalf("create temp table: %v", err)
	}
	t.Cleanup(func() {
		db.Exec(ctx, `DROP TABLE IF EXISTS hard_product`)
	})
}

func productRepo(t *testing.T, db *orm.DB) *orm.Repository[test_product] {
	t.Helper()
	r, err := orm.Repo[test_product](db)
	if err != nil {
		t.Fatalf("orm.Repo: %v", err)
	}
	return r
}

// ── Open → ping ───────────────────────────────────────────────────────────────

func TestIntegration_ORM_Open(t *testing.T) {
	db := openIntegrationDB(t)
	if db == nil {
		t.Fatal("expected non-nil DB")
	}
}

// ── Create ────────────────────────────────────────────────────────────────────

func TestIntegration_Create_ReturnsPopulatedEntity(t *testing.T) {
	db := openIntegrationDB(t)
	setupProductTable(t, db)
	r := productRepo(t, db)
	ctx := context.Background()

	p, err := r.Create(ctx, test_product{Name: "Widget", Price: 999, Category: "hardware"})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if p.ID == uuid.Nil {
		t.Error("ID must be set by PostgreSQL via RETURNING *")
	}
	if p.CreatedAt.IsZero() {
		t.Error("CreatedAt must be set by PostgreSQL")
	}
	if p.UpdatedAt.IsZero() {
		t.Error("UpdatedAt must be set by PostgreSQL")
	}
	if p.Name != "Widget" {
		t.Errorf("Name = %q, want %q", p.Name, "Widget")
	}
	if p.Price != 999 {
		t.Errorf("Price = %d, want 999", p.Price)
	}
	if p.DeletedAt != nil {
		t.Error("DeletedAt must be nil for a new entity")
	}
}

// ── FindByID ──────────────────────────────────────────────────────────────────

func TestIntegration_FindByID_Found(t *testing.T) {
	db := openIntegrationDB(t)
	setupProductTable(t, db)
	r := productRepo(t, db)
	ctx := context.Background()

	created, _ := r.Create(ctx, test_product{Name: "Gadget", Price: 100, Category: "elec"})
	found, err := r.FindByID(ctx, created.ID)
	if err != nil {
		t.Fatalf("FindByID: %v", err)
	}
	if found.ID != created.ID {
		t.Errorf("ID mismatch: got %s, want %s", found.ID, created.ID)
	}
	if found.Name != "Gadget" {
		t.Errorf("Name = %q, want %q", found.Name, "Gadget")
	}
}

func TestIntegration_FindByID_NotFound_Error(t *testing.T) {
	db := openIntegrationDB(t)
	setupProductTable(t, db)
	r := productRepo(t, db)
	_, err := r.FindByID(context.Background(), uuid.New())
	if err == nil {
		t.Fatal("expected error for non-existent ID")
	}
}

func TestIntegration_FindByID_SoftDeleted_NotFound(t *testing.T) {
	db := openIntegrationDB(t)
	setupProductTable(t, db)
	r := productRepo(t, db)
	ctx := context.Background()

	created, _ := r.Create(ctx, test_product{Name: "Gone", Price: 1, Category: "x"})
	r.Delete(ctx, created.ID) //nolint:errcheck
	_, err := r.FindByID(ctx, created.ID)
	if err == nil {
		t.Fatal("soft-deleted entity must not be returned by FindByID")
	}
}

// ── FindAll ───────────────────────────────────────────────────────────────────

func TestIntegration_FindAll_ReturnsAllActive(t *testing.T) {
	db := openIntegrationDB(t)
	setupProductTable(t, db)
	r := productRepo(t, db)
	ctx := context.Background()

	r.Create(ctx, test_product{Name: "A", Price: 1, Category: "x"}) //nolint:errcheck
	r.Create(ctx, test_product{Name: "B", Price: 2, Category: "x"}) //nolint:errcheck
	r.Create(ctx, test_product{Name: "C", Price: 3, Category: "x"}) //nolint:errcheck

	results, err := r.FindAll(ctx)
	if err != nil {
		t.Fatalf("FindAll: %v", err)
	}
	if len(results) < 3 {
		t.Errorf("expected at least 3 results, got %d", len(results))
	}
}

func TestIntegration_FindAll_WithCondition(t *testing.T) {
	db := openIntegrationDB(t)
	setupProductTable(t, db)
	r := productRepo(t, db)
	ctx := context.Background()

	r.Create(ctx, test_product{Name: "Open1", Price: 10, Category: "tools"})    //nolint:errcheck
	r.Create(ctx, test_product{Name: "Open2", Price: 20, Category: "tools"})    //nolint:errcheck
	r.Create(ctx, test_product{Name: "Other", Price: 30, Category: "supplies"}) //nolint:errcheck

	results, err := r.FindAll(ctx, orm.Cond("category = $1", "tools"))
	if err != nil {
		t.Fatalf("FindAll with condition: %v", err)
	}
	if len(results) != 2 {
		t.Errorf("expected 2 results for category=tools, got %d", len(results))
	}
	for _, p := range results {
		if p.Category != "tools" {
			t.Errorf("expected category=tools, got %q", p.Category)
		}
	}
}

func TestIntegration_FindAll_ExcludesSoftDeleted(t *testing.T) {
	db := openIntegrationDB(t)
	setupProductTable(t, db)
	r := productRepo(t, db)
	ctx := context.Background()

	p1, _ := r.Create(ctx, test_product{Name: "Keep", Price: 1, Category: "z"})
	p2, _ := r.Create(ctx, test_product{Name: "Delete", Price: 2, Category: "z"})
	r.Delete(ctx, p2.ID) //nolint:errcheck

	results, err := r.FindAll(ctx, orm.Cond("category = $1", "z"))
	if err != nil {
		t.Fatalf("FindAll: %v", err)
	}
	if len(results) != 1 {
		t.Errorf("expected 1 active result, got %d", len(results))
	}
	if results[0].ID != p1.ID {
		t.Error("wrong entity returned — soft-deleted one may have leaked through")
	}
}

func TestIntegration_FindAllWithDeleted_IncludesSoftDeleted(t *testing.T) {
	db := openIntegrationDB(t)
	setupProductTable(t, db)
	r := productRepo(t, db)
	ctx := context.Background()

	p, _ := r.Create(ctx, test_product{Name: "Deleted", Price: 1, Category: "audit"})
	r.Delete(ctx, p.ID) //nolint:errcheck

	results, err := r.FindAllWithDeleted(ctx, orm.Cond("category = $1", "audit"))
	if err != nil {
		t.Fatalf("FindAllWithDeleted: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("expected 1 result including deleted, got %d", len(results))
	}
	if results[0].DeletedAt == nil {
		t.Error("DeletedAt must be set on the soft-deleted entity")
	}
}

// ── Update ────────────────────────────────────────────────────────────────────

func TestIntegration_Update_ChangesFields(t *testing.T) {
	db := openIntegrationDB(t)
	setupProductTable(t, db)
	r := productRepo(t, db)
	ctx := context.Background()

	created, _ := r.Create(ctx, test_product{Name: "Old", Price: 10, Category: "cat"})
	time.Sleep(time.Millisecond)

	updated, err := r.Update(ctx, test_product{Name: "New", Price: 99, Category: "cat"}, created.ID)
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if updated.Name != "New" {
		t.Errorf("Name = %q, want %q", updated.Name, "New")
	}
	if updated.Price != 99 {
		t.Errorf("Price = %d, want 99", updated.Price)
	}
	if !updated.UpdatedAt.After(created.UpdatedAt) {
		t.Error("UpdatedAt must be advanced after Update")
	}
	if updated.ID != created.ID {
		t.Error("ID must not change after Update")
	}
}

func TestIntegration_Update_SoftDeleted_NoEffect(t *testing.T) {
	db := openIntegrationDB(t)
	setupProductTable(t, db)
	r := productRepo(t, db)
	ctx := context.Background()

	p, _ := r.Create(ctx, test_product{Name: "ToDelete", Price: 1, Category: "x"})
	r.Delete(ctx, p.ID) //nolint:errcheck

	_, err := r.Update(ctx, test_product{Name: "Ghost", Price: 0, Category: "x"}, p.ID)
	if err == nil {
		t.Fatal("expected error updating a soft-deleted entity")
	}
}

// ── Delete (soft) ─────────────────────────────────────────────────────────────

func TestIntegration_Delete_Soft_SetsDeletedAt(t *testing.T) {
	db := openIntegrationDB(t)
	setupProductTable(t, db)
	r := productRepo(t, db)
	ctx := context.Background()

	p, _ := r.Create(ctx, test_product{Name: "Bye", Price: 1, Category: "x"})
	n, err := r.Delete(ctx, p.ID)
	if err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if n != 1 {
		t.Errorf("RowsAffected = %d, want 1", n)
	}
	_, err = r.FindByID(ctx, p.ID)
	if err == nil {
		t.Fatal("soft-deleted entity must not be returned by FindByID")
	}
	results, _ := r.FindAllWithDeleted(ctx, orm.Cond("id = $1", p.ID))
	if len(results) != 1 || results[0].DeletedAt == nil {
		t.Error("soft-deleted entity must have DeletedAt set")
	}
}

func TestIntegration_Delete_Soft_IdempotentSecondCall(t *testing.T) {
	db := openIntegrationDB(t)
	setupProductTable(t, db)
	r := productRepo(t, db)
	ctx := context.Background()

	p, _ := r.Create(ctx, test_product{Name: "Once", Price: 1, Category: "x"})
	r.Delete(ctx, p.ID) //nolint:errcheck

	n, err := r.Delete(ctx, p.ID)
	if err != nil {
		t.Fatalf("second Delete error: %v", err)
	}
	if n != 0 {
		t.Errorf("second delete must affect 0 rows (already deleted), got %d", n)
	}
}

// ── Restore ───────────────────────────────────────────────────────────────────

func TestIntegration_Restore_ClearsDeletedAt(t *testing.T) {
	db := openIntegrationDB(t)
	setupProductTable(t, db)
	r := productRepo(t, db)
	ctx := context.Background()

	p, _ := r.Create(ctx, test_product{Name: "Restore", Price: 1, Category: "x"})
	r.Delete(ctx, p.ID) //nolint:errcheck

	if err := r.Restore(ctx, p.ID); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	found, err := r.FindByID(ctx, p.ID)
	if err != nil {
		t.Fatalf("FindByID after Restore: %v", err)
	}
	if found.DeletedAt != nil {
		t.Error("DeletedAt must be nil after Restore")
	}
}

// ── HardDelete ────────────────────────────────────────────────────────────────

func TestIntegration_HardDelete_RemovesPermanently(t *testing.T) {
	db := openIntegrationDB(t)
	setupProductTable(t, db)
	r := productRepo(t, db)
	ctx := context.Background()

	p, _ := r.Create(ctx, test_product{Name: "Permanent", Price: 1, Category: "x"})
	n, err := r.HardDelete(ctx, p.ID)
	if err != nil {
		t.Fatalf("HardDelete: %v", err)
	}
	if n != 1 {
		t.Errorf("RowsAffected = %d, want 1", n)
	}
	results, _ := r.FindAllWithDeleted(ctx, orm.Cond("id = $1", p.ID))
	if len(results) != 0 {
		t.Errorf("hard-deleted entity must not exist anywhere, found %d rows", len(results))
	}
}

// ── CreateBatch ───────────────────────────────────────────────────────────────

func TestIntegration_CreateBatch_InsertsAll(t *testing.T) {
	db := openIntegrationDB(t)
	setupProductTable(t, db)
	r := productRepo(t, db)
	ctx := context.Background()

	entities := []test_product{
		{Name: "Batch1", Price: 1, Category: "batch"},
		{Name: "Batch2", Price: 2, Category: "batch"},
		{Name: "Batch3", Price: 3, Category: "batch"},
	}
	results, err := r.CreateBatch(ctx, entities)
	if err != nil {
		t.Fatalf("CreateBatch: %v", err)
	}
	if len(results) != 3 {
		t.Fatalf("expected 3 results, got %d", len(results))
	}
	for i, p := range results {
		if p.ID == uuid.Nil {
			t.Errorf("results[%d].ID not set", i)
		}
		if p.CreatedAt.IsZero() {
			t.Errorf("results[%d].CreatedAt not set", i)
		}
	}
}

func TestIntegration_CreateBatch_SingleRoundTrip(t *testing.T) {
	db := openIntegrationDB(t)
	setupProductTable(t, db)
	r := productRepo(t, db)
	ctx := context.Background()

	entities := make([]test_product, 5)
	for i := range entities {
		entities[i] = test_product{Name: "Item", Price: i, Category: "bulk"}
	}
	results, err := r.CreateBatch(ctx, entities)
	if err != nil {
		t.Fatalf("CreateBatch: %v", err)
	}
	first := results[0].CreatedAt
	for i, p := range results[1:] {
		diff := p.CreatedAt.Sub(first)
		if diff < 0 {
			diff = -diff
		}
		if diff > 5*time.Millisecond {
			t.Errorf("results[%d].CreatedAt differs by %v — may not be a single round-trip", i+1, diff)
		}
	}
}

// ── Transaction ───────────────────────────────────────────────────────────────

func TestIntegration_Transaction_CommitMultipleRepos(t *testing.T) {
	db := openIntegrationDB(t)
	setupProductTable(t, db)
	ctx := context.Background()

	var createdID uuid.UUID
	err := orm.Transact(ctx, db, func(tx *orm.Tx) error {
		r, err := orm.Repo[test_product](tx)
		if err != nil {
			return err
		}
		p, err := r.Create(ctx, test_product{Name: "TxProduct", Price: 10, Category: "tx"})
		if err != nil {
			return err
		}
		createdID = p.ID
		return nil
	})
	if err != nil {
		t.Fatalf("Transaction: %v", err)
	}

	r := productRepo(t, db)
	found, err := r.FindByID(ctx, createdID)
	if err != nil {
		t.Fatalf("FindByID after commit: %v", err)
	}
	if found.Name != "TxProduct" {
		t.Errorf("Name = %q, want %q", found.Name, "TxProduct")
	}
}

func TestIntegration_Transaction_RollbackOnError(t *testing.T) {
	db := openIntegrationDB(t)
	setupProductTable(t, db)
	ctx := context.Background()

	boom := errors.New("something went wrong")
	var rolledBackID uuid.UUID

	err := orm.Transact(ctx, db, func(tx *orm.Tx) error {
		r, _ := orm.Repo[test_product](tx)
		p, err := r.Create(ctx, test_product{Name: "ShouldNotExist", Price: 1, Category: "rollback"})
		if err != nil {
			return err
		}
		rolledBackID = p.ID
		return boom
	})
	if !errors.Is(err, boom) {
		t.Fatalf("expected boom error, got %v", err)
	}

	r := productRepo(t, db)
	results, _ := r.FindAllWithDeleted(ctx, orm.Cond("id = $1", rolledBackID))
	if len(results) != 0 {
		t.Errorf("rolled-back entity must not exist, found %d rows", len(results))
	}
}

func TestIntegration_Transaction_WithTx_ScopedToTransaction(t *testing.T) {
	db := openIntegrationDB(t)
	setupProductTable(t, db)
	ctx := context.Background()

	r := productRepo(t, db)
	var createdID uuid.UUID

	err := orm.Transact(ctx, db, func(tx *orm.Tx) error {
		p, err := r.WithTx(tx).Create(ctx, test_product{Name: "WithTxProduct", Price: 5, Category: "withtx"})
		if err != nil {
			return err
		}
		createdID = p.ID
		return nil
	})
	if err != nil {
		t.Fatalf("Transaction: %v", err)
	}

	found, err := r.FindByID(ctx, createdID)
	if err != nil {
		t.Fatalf("FindByID: %v", err)
	}
	if found.Name != "WithTxProduct" {
		t.Errorf("Name = %q, want %q", found.Name, "WithTxProduct")
	}
}

// ── Query builder drop-through ────────────────────────────────────────────────

// ── Upsert ────────────────────────────────────────────────────────────────────

// test_sku has a business-key unique constraint (sku) — required for ON CONFLICT.
type test_sku struct {
	ID    uuid.UUID `db:"id,pk"`
	SKU   string    `db:"sku"`
	Stock int       `db:"stock"`
	Price int       `db:"price"`
}

func (test_sku) TableName() string { return "test_sku" }

func setupSKUTable(t *testing.T, db *orm.DB) {
	t.Helper()
	ctx := context.Background()
	_, err := db.Exec(ctx, `
		CREATE TEMP TABLE IF NOT EXISTS test_sku (
			id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			sku   TEXT NOT NULL UNIQUE,
			stock INT  NOT NULL DEFAULT 0,
			price INT  NOT NULL DEFAULT 0
		)
	`)
	if err != nil {
		t.Fatalf("create temp table: %v", err)
	}
	t.Cleanup(func() { db.Exec(ctx, `DROP TABLE IF EXISTS test_sku`) }) //nolint:errcheck
}

func skuRepo(t *testing.T, db *orm.DB) *orm.Repository[test_sku] {
	t.Helper()
	r, err := orm.Repo[test_sku](db)
	if err != nil {
		t.Fatalf("orm.Repo: %v", err)
	}
	return r
}

func TestIntegration_Upsert_DoUpdate_InsertsOnFirstCall(t *testing.T) {
	db := openIntegrationDB(t)
	setupSKUTable(t, db)
	r := skuRepo(t, db)
	ctx := context.Background()

	row := test_sku{SKU: "ABC-001", Stock: 10, Price: 100}
	got, err := query.Upsert[test_sku](r.Meta(), row).
		OnConflict("sku").
		DoUpdate().
		Returning("*").
		One(ctx, db)

	if err != nil {
		t.Fatalf("Upsert insert: %v", err)
	}
	if got.ID == uuid.Nil {
		t.Error("ID must be set after insert")
	}
	if got.SKU != "ABC-001" || got.Stock != 10 {
		t.Errorf("got %+v", got)
	}
}

func TestIntegration_Upsert_DoUpdate_UpdatesOnConflict(t *testing.T) {
	db := openIntegrationDB(t)
	setupSKUTable(t, db)
	r := skuRepo(t, db)
	ctx := context.Background()

	first := test_sku{SKU: "ABC-002", Stock: 5, Price: 50}
	query.Upsert[test_sku](r.Meta(), first).OnConflict("sku").DoUpdate().Exec(ctx, db) //nolint:errcheck

	second := test_sku{SKU: "ABC-002", Stock: 99, Price: 200}
	got, err := query.Upsert[test_sku](r.Meta(), second).
		OnConflict("sku").
		DoUpdate().
		Returning("*").
		One(ctx, db)

	if err != nil {
		t.Fatalf("Upsert update: %v", err)
	}
	if got.Stock != 99 || got.Price != 200 {
		t.Errorf("expected updated values, got stock=%d price=%d", got.Stock, got.Price)
	}
}

func TestIntegration_Upsert_DoUpdateSet_PartialUpdate(t *testing.T) {
	db := openIntegrationDB(t)
	setupSKUTable(t, db)
	r := skuRepo(t, db)
	ctx := context.Background()

	// Insert initial row.
	initial := test_sku{SKU: "ABC-003", Stock: 10, Price: 500}
	query.Upsert[test_sku](r.Meta(), initial).OnConflict("sku").DoUpdate().Exec(ctx, db) //nolint:errcheck

	// Conflict: only update stock, price must be preserved.
	conflict := test_sku{SKU: "ABC-003", Stock: 20, Price: 999}
	got, err := query.Upsert[test_sku](r.Meta(), conflict).
		OnConflict("sku").
		DoUpdateSet("stock").
		Returning("*").
		One(ctx, db)

	if err != nil {
		t.Fatalf("Upsert DoUpdateSet: %v", err)
	}
	if got.Stock != 20 {
		t.Errorf("stock should be updated to 20, got %d", got.Stock)
	}
	if got.Price != 500 {
		t.Errorf("price must remain 500 (not overwritten), got %d", got.Price)
	}
}

func TestIntegration_Upsert_DoNothing_IgnoresConflict(t *testing.T) {
	db := openIntegrationDB(t)
	setupSKUTable(t, db)
	r := skuRepo(t, db)
	ctx := context.Background()

	row := test_sku{SKU: "ABC-004", Stock: 1, Price: 10}
	query.Upsert[test_sku](r.Meta(), row).OnConflict("sku").DoNothing().Exec(ctx, db) //nolint:errcheck
	query.Upsert[test_sku](r.Meta(), test_sku{SKU: "ABC-004", Stock: 999, Price: 999}).
		OnConflict("sku").DoNothing().Exec(ctx, db) //nolint:errcheck

	all, err := r.FindAll(ctx)
	if err != nil {
		t.Fatalf("FindAll: %v", err)
	}
	if len(all) != 1 || all[0].Stock != 1 {
		t.Errorf("DoNothing must leave original row intact: got %+v", all)
	}
}

func TestIntegration_Upsert_Batch_MultipleRows(t *testing.T) {
	db := openIntegrationDB(t)
	setupSKUTable(t, db)
	r := skuRepo(t, db)
	ctx := context.Background()

	rows := []test_sku{
		{SKU: "BATCH-1", Stock: 1, Price: 10},
		{SKU: "BATCH-2", Stock: 2, Price: 20},
		{SKU: "BATCH-3", Stock: 3, Price: 30},
	}
	results, err := query.Upsert[test_sku](r.Meta(), rows...).
		OnConflict("sku").
		DoUpdate().
		Returning("*").
		Batch(ctx, db)

	if err != nil {
		t.Fatalf("Upsert Batch: %v", err)
	}
	if len(results) != 3 {
		t.Fatalf("expected 3 results, got %d", len(results))
	}
	for i, res := range results {
		if res.ID == uuid.Nil {
			t.Errorf("results[%d].ID not set", i)
		}
	}
}

// ── DeleteWhere ───────────────────────────────────────────────────────────────

func TestIntegration_DeleteWhere_SoftDelete_ByCategory(t *testing.T) {
	db := openIntegrationDB(t)
	setupProductTable(t, db)
	r := productRepo(t, db)
	ctx := context.Background()

	r.Create(ctx, test_product{Name: "A", Price: 1, Category: "clearance"}) //nolint:errcheck
	r.Create(ctx, test_product{Name: "B", Price: 2, Category: "clearance"}) //nolint:errcheck
	r.Create(ctx, test_product{Name: "C", Price: 3, Category: "keep"})      //nolint:errcheck

	n, err := r.DeleteWhere(ctx, orm.Cond("category = $1", "clearance"))
	if err != nil {
		t.Fatalf("DeleteWhere: %v", err)
	}
	if n != 2 {
		t.Errorf("expected 2 rows affected, got %d", n)
	}

	active, _ := r.FindAll(ctx)
	if len(active) != 1 || active[0].Name != "C" {
		t.Errorf("only 'keep' row must remain active, got %+v", active)
	}

	all, _ := r.FindAllWithDeleted(ctx)
	if len(all) != 3 {
		t.Errorf("soft-deleted rows must still exist, got %d total", len(all))
	}
}

func TestIntegration_DeleteWhere_SoftDelete_MultiCondition(t *testing.T) {
	db := openIntegrationDB(t)
	setupProductTable(t, db)
	r := productRepo(t, db)
	ctx := context.Background()

	r.Create(ctx, test_product{Name: "Cheap", Price: 5, Category: "sale"})       //nolint:errcheck
	r.Create(ctx, test_product{Name: "Expensive", Price: 500, Category: "sale"}) //nolint:errcheck

	// Only delete rows in "sale" with price < 100 — should hit exactly 1.
	n, err := r.DeleteWhere(ctx,
		orm.Cond("category = $1", "sale"),
		orm.Cond("price < $1", 100),
	)
	if err != nil {
		t.Fatalf("DeleteWhere multi-condition: %v", err)
	}
	if n != 1 {
		t.Errorf("expected 1 row affected, got %d", n)
	}

	active, _ := r.FindAll(ctx)
	if len(active) != 1 || active[0].Name != "Expensive" {
		t.Errorf("only expensive row must remain, got %+v", active)
	}
}

func TestIntegration_DeleteWhere_HardDelete_RemovesRows(t *testing.T) {
	db := openIntegrationDB(t)
	setupHardTable(t, db)
	ctx := context.Background()
	hr, err := orm.Repo[hardProduct](db)
	if err != nil {
		t.Fatalf("orm.Repo: %v", err)
	}

	hr.Create(ctx, hardProduct{Label: "old"})  //nolint:errcheck
	hr.Create(ctx, hardProduct{Label: "old"})  //nolint:errcheck
	hr.Create(ctx, hardProduct{Label: "keep"}) //nolint:errcheck

	n, err := hr.DeleteWhere(ctx, orm.Cond("label = $1", "old"))
	if err != nil {
		t.Fatalf("DeleteWhere hard: %v", err)
	}
	if n != 2 {
		t.Errorf("expected 2 rows deleted, got %d", n)
	}

	remaining, _ := hr.FindAll(ctx)
	if len(remaining) != 1 || remaining[0].Label != "keep" {
		t.Errorf("only 'keep' row must survive, got %+v", remaining)
	}
}

func TestIntegration_DeleteWhere_NoConditions_ReturnsError(t *testing.T) {
	db := openIntegrationDB(t)
	setupProductTable(t, db)
	r := productRepo(t, db)
	ctx := context.Background()

	_, err := r.DeleteWhere(ctx)
	if err == nil {
		t.Fatal("expected error when no conditions passed")
	}
}

// ── QueryBuilder complex ──────────────────────────────────────────────────────

func TestIntegration_QueryBuilder_Complex(t *testing.T) {
	db := openIntegrationDB(t)
	setupProductTable(t, db)
	r := productRepo(t, db)
	ctx := context.Background()

	r.Create(ctx, test_product{Name: "Cheap", Price: 5, Category: "tools"})       //nolint:errcheck
	r.Create(ctx, test_product{Name: "Mid", Price: 50, Category: "tools"})        //nolint:errcheck
	r.Create(ctx, test_product{Name: "Expensive", Price: 500, Category: "tools"}) //nolint:errcheck

	results, err := query.Select[test_product](r.Meta()).
		Where(orm.Cond("category = $1", "tools")).
		Where(orm.Cond("price > $1", 10)).
		Where(orm.Cond("deleted_at IS NULL")).
		OrderBy("price ASC").
		All(ctx, db)

	if err != nil {
		t.Fatalf("Select builder: %v", err)
	}
	if len(results) != 2 {
		t.Fatalf("expected 2 results (price > 10), got %d", len(results))
	}
	if results[0].Price > results[1].Price {
		t.Error("results must be ordered by price ASC")
	}
}
