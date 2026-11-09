package chatter

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

// rs_item_chatter is a throwaway row-scoped table: a caller sees only the rows whose
// owner is the one the test stamps on its request context.
type rsItemChatter struct {
	model.BaseModel
	Owner string `db:"owner"`
}

type scopeOwner struct{}
type scopeFail struct{}

var registerrsItemChatter sync.Once

type scopeFixture struct {
	app             *orm.App
	tenant          uuid.UUID
	visible, hidden uuid.UUID
	identity        auth.Identity
}

func newScopeFixture(t *testing.T) scopeFixture {
	t.Helper()
	app := testdb.Open(t)
	registerrsItemChatter.Do(func() {
		err := orm.Register[rsItemChatter](orm.WithRowScope(func(ctx context.Context) (query.Condition, bool, error) {
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
	testdb.Migrate(t, app, "rs_item_chatter")
	tenant := uuid.New()
	bg := context.Background()
	t.Cleanup(func() { _, _ = app.DB.Exec(bg, `DELETE FROM rs_item_chatter WHERE tenant_id = $1`, tenant) })
	insert := func(owner string) uuid.UUID {
		var id uuid.UUID
		if err := app.DB.QueryRow(bg, `INSERT INTO rs_item_chatter (tenant_id, owner) VALUES ($1, $2) RETURNING id`, tenant, owner).Scan(&id); err != nil {
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

func TestChatter_HiddenAnchor404(t *testing.T) {
	f := newScopeFixture(t)
	store := &stubStore{}
	h := NewHandler(store, &stubUsers{}).WithRowScope(f.app.DB)
	list := func(id uuid.UUID, failing bool) int {
		return serve(t, f.as(h.List, failing), http.MethodGet, "/x?table=rs_item_chatter&record="+id.String(), nil, f.identity, nil).Code
	}
	create := func(table string, id uuid.UUID) int {
		body := `{"table_name":"` + table + `","record_id":"` + id.String() + `","kind":"message","body":"hi"}`
		return serve(t, f.as(h.Create, false), http.MethodPost, "/x", strings.NewReader(body), f.identity, nil).Code
	}
	if c := list(f.hidden, false); c != 404 {
		t.Errorf("List hidden = %d, want 404", c)
	}
	if c := create("rs_item_chatter", f.hidden); c != 404 || store.created != nil {
		t.Errorf("Create hidden = %d created=%v, want 404 and nothing inserted", c, store.created)
	}
	if c := list(f.visible, false); c != 200 {
		t.Errorf("List visible = %d", c)
	}
	if c := create("rs_item_chatter", f.visible); c != 201 {
		t.Errorf("Create visible = %d", c)
	}
	if c := list(f.visible, true); c != 500 {
		t.Errorf("List with failing scope = %d, want 500 (not 404)", c)
	}
}

func TestChatter_UnscopedTableUnchanged(t *testing.T) {
	f := newScopeFixture(t)
	h := NewHandler(&stubStore{}, &stubUsers{}).WithRowScope(f.app.DB)
	rec := serve(t, f.as(h.List, false), http.MethodGet, "/x?table=plain_table&record="+uuid.NewString(), nil, f.identity, nil)
	want(t, "List unscoped", rec, 200)
}
