package crud_test

import (
	"context"
	"errors"
	"sync"
	"testing"

	"core/internal/testdb"
	"core/orm"
	"core/orm/access"
	"core/orm/geo"
	"core/orm/internal/crud"
	"core/orm/internal/registry"
	"core/orm/model"
	"core/orm/query"

	"github.com/google/uuid"
)

// rowScopeItem is a throwaway row-scoped table: a caller sees only the rows
// whose owner is the one stamped on its context.
type rowScopeItem struct {
	model.BaseModel
	Owner string     `db:"owner"`
	Spot  *geo.Point `db:"spot"`
}

// rowScopeFree has the same shape and no scope (CanSeeRecord's "no scope" case).
type rowScopeFree struct {
	model.BaseModel
	Owner string `db:"owner"`
}

type ownerKey struct{}

// scopeMode drives the scope func: "" filters by owner, "open" = no
// restriction, "fail" = error.
type modeKey struct{}

func asOwner(ctx context.Context, owner string) context.Context {
	return context.WithValue(ctx, ownerKey{}, owner)
}

func rowScope(ctx context.Context) (query.Condition, bool, error) {
	switch ctx.Value(modeKey{}) {
	case "open":
		return query.Condition{}, false, nil
	case "fail":
		return query.Condition{}, false, errors.New("scope unavailable")
	}
	owner, _ := ctx.Value(ownerKey{}).(string)
	return query.NewCondition("owner = $1", owner), true, nil
}

var registerRowScope sync.Once

type rowScopeFixture struct {
	app      *orm.App
	repo     *crud.Repository
	tenant   uuid.UUID
	ctxA     context.Context
	idA, idB uuid.UUID
	freeID   uuid.UUID
	deletedA uuid.UUID
}

func newRowScopeFixture(t *testing.T) rowScopeFixture {
	t.Helper()
	app := testdb.Open(t)
	registerRowScope.Do(func() {
		if err := registry.Register[rowScopeItem](registry.WithRowScope(rowScope)); err != nil {
			t.Fatal(err)
		}
		if err := registry.Register[rowScopeFree](); err != nil {
			t.Fatal(err)
		}
	})
	testdb.Migrate(t, app, "row_scope_item", "row_scope_free")
	tenant := uuid.New()
	bg := context.Background()
	t.Cleanup(func() {
		_, _ = app.DB.Exec(bg, `DELETE FROM row_scope_item WHERE tenant_id = $1`, tenant)
		_, _ = app.DB.Exec(bg, `DELETE FROM row_scope_free WHERE tenant_id = $1`, tenant)
	})
	insert := func(table, owner string, deleted bool) uuid.UUID {
		var id uuid.UUID
		sql := `INSERT INTO ` + table + ` (tenant_id, owner, deleted_at) VALUES ($1, $2, CASE WHEN $3 THEN now() END) RETURNING id`
		if err := app.DB.QueryRow(bg, sql, tenant, owner, deleted).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	meta, _ := registry.Get("row_scope_item")
	return rowScopeFixture{
		app:      app,
		repo:     crud.NewRepository(app.DB, meta),
		tenant:   tenant,
		ctxA:     asOwner(access.WithTenant(bg, tenant), "A"),
		idA:      insert("row_scope_item", "A", false),
		idB:      insert("row_scope_item", "B", false),
		deletedA: insert("row_scope_item", "A", true),
		freeID:   insert("row_scope_free", "B", false),
	}
}

func (f rowScopeFixture) ownerOf(t *testing.T, id uuid.UUID) (string, bool) {
	t.Helper()
	var owner string
	var deleted bool
	if err := f.app.DB.QueryRow(context.Background(),
		`SELECT owner, deleted_at IS NOT NULL FROM row_scope_item WHERE id = $1`, id).Scan(&owner, &deleted); err != nil {
		t.Fatal(err)
	}
	return owner, deleted
}

func TestRowScope_FindAllFilters(t *testing.T) {
	f := newRowScopeFixture(t)
	rows, total, err := f.repo.FindAll(f.ctxA, crud.ListFilter{Page: 1, PageSize: 20})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || total.Rows != 1 || rows[0]["owner"] != "A" {
		t.Errorf("rows=%v total=%d, want A's row only", rows, total.Rows)
	}
}

func TestRowScope_FindByIDNotFound(t *testing.T) {
	f := newRowScopeFixture(t)
	if _, err := f.repo.FindByID(f.ctxA, f.idB); !errors.Is(err, crud.ErrNotFound) {
		t.Errorf("A reading B's row: err = %v, want ErrNotFound", err)
	}
	if _, err := f.repo.FindByID(f.ctxA, f.idA); err != nil {
		t.Errorf("A reading its own row: %v", err)
	}
}

func TestRowScope_DistinctAndAggregate(t *testing.T) {
	f := newRowScopeFixture(t)
	vals, err := f.repo.DistinctValues(f.ctxA, "owner", crud.ListFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(vals) != 1 || vals[0].Value != "A" || vals[0].Total != 1 {
		t.Errorf("distinct = %+v, want only A×1", vals)
	}
	agg, err := f.repo.Aggregate(f.ctxA, crud.AggregateRequest{Kind: "count"}, crud.ListFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(agg) != 1 || agg[0].Count != 1 {
		t.Errorf("aggregate = %+v, want count 1", agg)
	}
}

func TestRowScope_UpdateDeleteRestoreNotFound(t *testing.T) {
	f := newRowScopeFixture(t)
	if _, err := f.repo.Update(f.ctxA, f.idB, map[string]any{"owner": "A"}); !errors.Is(err, crud.ErrNotFound) {
		t.Errorf("update: err = %v, want ErrNotFound", err)
	}
	if err := f.repo.Delete(f.ctxA, f.idB); !errors.Is(err, crud.ErrNotFound) {
		t.Errorf("delete: err = %v, want ErrNotFound", err)
	}
	if owner, deleted := f.ownerOf(t, f.idB); owner != "B" || deleted {
		t.Errorf("B's row changed: owner=%s deleted=%v", owner, deleted)
	}
	// Restore: B's row soft-deleted out of band, A can't bring it back.
	if _, err := f.app.DB.Exec(context.Background(), `UPDATE row_scope_item SET deleted_at = now() WHERE id = $1`, f.idB); err != nil {
		t.Fatal(err)
	}
	if _, err := f.repo.Restore(f.ctxA, f.idB); !errors.Is(err, crud.ErrNotFound) {
		t.Errorf("restore: err = %v, want ErrNotFound", err)
	}
	if _, deleted := f.ownerOf(t, f.idB); !deleted {
		t.Error("B's row restored by A")
	}
}

func TestRowScope_HardDeleteNotFound(t *testing.T) {
	f := newRowScopeFixture(t)
	meta, _ := registry.Get("row_scope_item")
	meta.SoftDelete = false // drive the hard-delete path on the same table
	if err := crud.NewRepository(f.app.DB, meta).Delete(f.ctxA, f.idB); !errors.Is(err, crud.ErrNotFound) {
		t.Errorf("hard delete: err = %v, want ErrNotFound", err)
	}
	f.ownerOf(t, f.idB) // still there (Scan fails otherwise)
}

func TestRowScope_NoRestrictionWhenNotOK(t *testing.T) {
	f := newRowScopeFixture(t)
	ctx := context.WithValue(f.ctxA, modeKey{}, "open")
	_, total, err := f.repo.FindAll(ctx, crud.ListFilter{Page: 1, PageSize: 20})
	if err != nil || total.Rows != 2 {
		t.Errorf("total=%d err=%v, want both rows", total.Rows, err)
	}
}

func TestRowScope_ErrorFailsClosed(t *testing.T) {
	f := newRowScopeFixture(t)
	ctx := context.WithValue(f.ctxA, modeKey{}, "fail")
	if _, _, err := f.repo.FindAll(ctx, crud.ListFilter{Page: 1, PageSize: 20}); err == nil {
		t.Error("list: want an error")
	}
	if _, err := f.repo.FindByID(ctx, f.idA); err == nil || errors.Is(err, crud.ErrNotFound) {
		t.Errorf("get: err = %v, want a non-404 error", err)
	}
	if err := f.repo.Delete(ctx, f.idA); err == nil {
		t.Error("delete: want an error")
	}
	if ok, err := crud.CanSeeRecord(ctx, f.app.DB, "row_scope_item", f.idA); err == nil || ok {
		t.Errorf("CanSeeRecord = %v, %v, want an error", ok, err)
	}
}

func TestRowScope_NeverCached(t *testing.T) {
	f := newRowScopeFixture(t)
	spy := &spyCache{}
	defer crud.StubCache(spy)()
	ctxB := asOwner(access.WithTenant(context.Background(), f.tenant), "B")
	a, _, errA := f.repo.FindAll(f.ctxA, crud.ListFilter{Page: 1, PageSize: 20})
	b, _, errB := f.repo.FindAll(ctxB, crud.ListFilter{Page: 1, PageSize: 20})
	if errA != nil || errB != nil {
		t.Fatal(errA, errB)
	}
	if len(a) != 1 || len(b) != 1 || a[0]["owner"] == b[0]["owner"] {
		t.Errorf("A=%v B=%v, want each caller's own row", a, b)
	}
	_, _ = f.repo.FindByID(f.ctxA, f.idA)
	_, _ = f.repo.DistinctValues(f.ctxA, "owner", crud.ListFilter{})
	_, _ = f.repo.Aggregate(f.ctxA, crud.AggregateRequest{Kind: "count"}, crud.ListFilter{})
	if spy.lookups != 0 || spy.stores != 0 {
		t.Errorf("cache used: lookups=%d stores=%d", spy.lookups, spy.stores)
	}
}

func TestCanSeeRecord(t *testing.T) {
	f := newRowScopeFixture(t)
	for _, tc := range []struct {
		name  string
		table string
		id    uuid.UUID
		want  bool
	}{
		{"own", "row_scope_item", f.idA, true},
		{"other's", "row_scope_item", f.idB, false},
		{"soft-deleted own", "row_scope_item", f.deletedA, false},
		{"table without scope", "row_scope_free", f.freeID, true},
		{"unregistered table", "no_such_table", uuid.New(), true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := crud.CanSeeRecord(f.ctxA, f.app.DB, tc.table, tc.id)
			if err != nil || got != tc.want {
				t.Errorf("CanSeeRecord = %v, %v, want %v", got, err, tc.want)
			}
		})
	}
}

// A geo reference to a row-scoped table is refused: its subquery would
// otherwise read a record the caller can't see.
func TestRowScope_GeoReferenceRefused(t *testing.T) {
	f := newRowScopeFixture(t)
	ctx := access.WithReadCheck(f.ctxA, func(string) bool { return true })
	_, err := crud.Distance(ctx, f.app.DB, "row_scope_item:"+f.idB.String()+":spot", "row_scope_item:"+f.idA.String()+":spot")
	if !errors.Is(err, crud.ErrGeoRef) {
		t.Errorf("err = %v, want ErrGeoRef", err)
	}
}
