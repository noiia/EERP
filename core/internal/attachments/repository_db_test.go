package attachments_test

import (
	"context"
	"errors"
	"testing"

	"core/internal/attachments"
	"core/internal/testdb"
	_ "core/modules/attachments" // registers the table for MigrateModules
	"core/orm"

	"github.com/google/uuid"
)

// The metadata store is tenant-pinned: another tenant's id or anchor reads as
// missing, and a delete through the wrong tenant removes nothing.
func TestRepository_TenantPinnedCRUD(t *testing.T) {
	app := testdb.Open(t)
	testdb.MigrateModules(t, app, "attachments")
	ctx := context.Background()
	tenant, other, record := uuid.New(), uuid.New(), uuid.New()
	t.Cleanup(func() { _, _ = app.DB.Exec(ctx, `DELETE FROM attachment WHERE tenant_id = $1`, tenant) })
	repo := attachments.NewRepository(app.DB)

	a, err := repo.Create(ctx, attachments.Attachment{TenantID: tenant, TableName: "invoice", RecordID: record, Field: "pdf",
		ObjectKey: "k1", Filename: "invoice.pdf", Mime: "application/pdf", Size: 10})
	if err != nil {
		t.Fatal(err)
	}
	if got, err := repo.FindInTenant(ctx, tenant, a.ID); err != nil || got.Filename != "invoice.pdf" {
		t.Fatalf("find: %v %v", got, err)
	}
	if _, err := repo.FindInTenant(ctx, other, a.ID); !errors.Is(err, orm.ErrNotFound) {
		t.Fatalf("other tenant: %v, want ErrNotFound", err)
	}
	if got, err := repo.FindByAnchor(ctx, tenant, "invoice", record, "pdf"); err != nil || got.ID != a.ID {
		t.Fatalf("by anchor: %v %v", got, err)
	}
	if _, err := repo.FindByAnchor(ctx, tenant, "invoice", record, "other"); !errors.Is(err, orm.ErrNotFound) {
		t.Fatalf("missing anchor: %v, want ErrNotFound", err)
	}
	a.ObjectKey, a.Filename = "k2", "invoice-v2.pdf"
	if got, err := repo.Update(ctx, a, a.ID); err != nil || got.ObjectKey != "k2" {
		t.Fatalf("update: %v %v", got, err)
	}
	if err := repo.Delete(ctx, other, a.ID); !errors.Is(err, orm.ErrNotFound) {
		t.Fatalf("delete through another tenant: %v, want ErrNotFound", err)
	}
	if err := repo.Delete(ctx, tenant, a.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.FindInTenant(ctx, tenant, a.ID); !errors.Is(err, orm.ErrNotFound) {
		t.Fatalf("after delete: %v, want ErrNotFound", err)
	}
}

func TestRepository_DatabaseDown(t *testing.T) {
	repo := attachments.NewRepository(testdb.Closed(t).DB)
	ctx := context.Background()
	if _, err := repo.FindInTenant(ctx, uuid.New(), uuid.New()); err == nil || errors.Is(err, orm.ErrNotFound) {
		t.Fatalf("find: %v, want a database error", err)
	}
	if _, err := repo.FindByAnchor(ctx, uuid.New(), "t", uuid.New(), "f"); err == nil || errors.Is(err, orm.ErrNotFound) {
		t.Fatalf("by anchor: %v, want a database error", err)
	}
	if err := repo.Delete(ctx, uuid.New(), uuid.New()); err == nil {
		t.Fatal("delete: want an error")
	}
}
