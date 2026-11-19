package pictures_test

import (
	"context"
	"testing"

	"core/internal/pictures"
	"core/internal/testdb"
	_ "core/modules/warehouse"

	"github.com/google/uuid"
)

// SetFlag writes a registered table's bool flag column, scoped to the tenant,
// and ignores an anchor whose field is not a bool column.
func TestRepository_SetFlag(t *testing.T) {
	app := testdb.Open(t)
	testdb.MigrateModules(t, app, "warehouse")
	ctx := context.Background()
	tenant, other := uuid.New(), uuid.New()
	t.Cleanup(func() {
		_, _ = app.DB.Exec(ctx, `DELETE FROM product WHERE tenant_id = ANY($1)`, []uuid.UUID{tenant, other})
	})

	var id uuid.UUID
	if err := app.DB.QueryRow(ctx, `INSERT INTO product (tenant_id, name) VALUES ($1, 'P') RETURNING id`, tenant).Scan(&id); err != nil {
		t.Fatal(err)
	}
	repo := pictures.NewRepository(app.DB)
	flag := func() *bool {
		var v *bool
		_ = app.DB.QueryRow(ctx, `SELECT picture FROM product WHERE id = $1`, id).Scan(&v)
		return v
	}

	if err := repo.SetFlag(ctx, other, "product", id, "picture", true); err != nil || flag() != nil {
		t.Fatalf("another tenant's call touched the row: err=%v flag=%v", err, flag())
	}
	if err := repo.SetFlag(ctx, tenant, "product", id, "picture", true); err != nil || flag() == nil || !*flag() {
		t.Fatalf("set: err=%v flag=%v", err, flag())
	}
	if err := repo.SetFlag(ctx, tenant, "product", id, "picture", false); err != nil || *flag() {
		t.Fatalf("clear: err=%v flag=%v", err, flag())
	}
	if err := repo.SetFlag(ctx, tenant, "product", id, "name", true); err != nil {
		t.Fatalf("non-bool field must be a no-op, got %v", err)
	}
}
