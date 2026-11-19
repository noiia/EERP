package notebook

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync"
	"testing"

	"core/internal/auth"
	"core/internal/testdb"
	"core/orm"
	"core/orm/access"
	"core/orm/model"
	"core/orm/query"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

// rs_item_notebook is a throwaway row-scoped table: a caller sees only the rows whose
// owner is the one the test stamps on its request context.
type rsItemNotebook struct {
	model.BaseModel
	Owner string `db:"owner"`
}

type scopeOwner struct{}
type scopeFail struct{}

var registerrsItemNotebook sync.Once

type scopeFixture struct {
	app             *orm.App
	tenant          uuid.UUID
	visible, hidden uuid.UUID
	identity        auth.Identity
}

func newScopeFixture(t *testing.T) scopeFixture {
	t.Helper()
	app := testdb.Open(t)
	registerrsItemNotebook.Do(func() {
		err := orm.Register[rsItemNotebook](orm.WithRowScope(func(ctx context.Context) (query.Condition, bool, error) {
			if ctx.Value(scopeFail{}) != nil {
				return query.Condition{}, false, errors.New("scope unavailable")
			}
			owner, _ := ctx.Value(scopeOwner{}).(string)
			return orm.Cond("owner = $1", owner), true, nil
		}))
		if err != nil {
			t.Fatal(err)
		}
	})
	testdb.Migrate(t, app, "rs_item_notebook")
	tenant := uuid.New()
	bg := context.Background()
	t.Cleanup(func() { _, _ = app.DB.Exec(bg, `DELETE FROM rs_item_notebook WHERE tenant_id = $1`, tenant) })
	insert := func(owner string) uuid.UUID {
		var id uuid.UUID
		if err := app.DB.QueryRow(bg, `INSERT INTO rs_item_notebook (tenant_id, owner) VALUES ($1, $2) RETURNING id`, tenant, owner).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	return scopeFixture{app: app, tenant: tenant, visible: insert("A"), hidden: insert("B"),
		identity: auth.Identity{TenantID: tenant, UserID: uuid.New()}}
}

// as runs h as owner A (or, failing, with a broken scope func) in this tenant.
func (f scopeFixture) as(h echo.HandlerFunc, failing bool) echo.HandlerFunc {
	return func(c *echo.Context) error {
		ctx := context.WithValue(access.WithTenant(c.Request().Context(), f.tenant), scopeOwner{}, "A")
		if failing {
			ctx = context.WithValue(ctx, scopeFail{}, true)
		}
		c.SetRequest(c.Request().WithContext(ctx))
		return h(c)
	}
}

func want(t *testing.T, name string, rec interface{ Result() *http.Response }, status int) {
	t.Helper()
	if got := rec.Result().StatusCode; got != status {
		t.Errorf("%s: status = %d, want %d", name, got, status)
	}
}

var _ = strings.NewReader

func TestNotebook_HiddenAnchor404(t *testing.T) {
	f := newScopeFixture(t)
	store := &stubStore{found: NotebookPage{TableName: "rs_item_notebook", RecordID: f.hidden}}
	h := NewHandler(store).WithRowScope(f.app.DB)
	id := map[string]string{"id": uuid.NewString()}
	rec := serve(t, f.as(h.List, false), http.MethodGet, "/x?table=rs_item_notebook&record="+f.hidden.String(), nil, f.identity, nil)
	want(t, "List hidden", rec, 404)
	rec = serve(t, f.as(h.Create, false), http.MethodPost, "/x",
		strings.NewReader(`{"table_name":"rs_item_notebook","record_id":"`+f.hidden.String()+`","title":"t"}`), f.identity, nil)
	want(t, "Create hidden", rec, 404)
	if store.created != nil {
		t.Error("Create hidden inserted a page")
	}
	rec = serve(t, f.as(h.Update, false), http.MethodPut, "/x", strings.NewReader(`{"title":"t"}`), f.identity, id)
	want(t, "Update hidden", rec, 404)
	if store.updated != nil {
		t.Error("Update hidden wrote")
	}
	rec = serve(t, f.as(h.Delete, false), http.MethodDelete, "/x", nil, f.identity, id)
	want(t, "Delete hidden", rec, 404)
	if store.deletedID != uuid.Nil {
		t.Error("Delete hidden deleted")
	}
	rec = serve(t, f.as(h.List, false), http.MethodGet, "/x?table=rs_item_notebook&record="+f.visible.String(), nil, f.identity, nil)
	want(t, "List visible", rec, 200)
	rec = serve(t, f.as(h.List, true), http.MethodGet, "/x?table=rs_item_notebook&record="+f.visible.String(), nil, f.identity, nil)
	want(t, "List failing scope", rec, 500)
}

func TestNotebook_UnscopedTableUnchanged(t *testing.T) {
	f := newScopeFixture(t)
	h := NewHandler(&stubStore{}).WithRowScope(f.app.DB)
	rec := serve(t, f.as(h.List, false), http.MethodGet, "/x?table=plain_table&record="+uuid.NewString(), nil, f.identity, nil)
	want(t, "List unscoped", rec, 200)
}
