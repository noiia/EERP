package attachments

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

// rs_item_attachments is a throwaway row-scoped table: a caller sees only the rows whose
// owner is the one the test stamps on its request context.
type rsItemAttachments struct {
	model.BaseModel
	Owner string `db:"owner"`
}

type scopeOwner struct{}
type scopeFail struct{}

var registerrsItemAttachments sync.Once

type scopeFixture struct {
	app             *orm.App
	tenant          uuid.UUID
	visible, hidden uuid.UUID
	identity        auth.Identity
}

func newScopeFixture(t *testing.T) scopeFixture {
	t.Helper()
	app := testdb.Open(t)
	registerrsItemAttachments.Do(func() {
		err := orm.Register[rsItemAttachments](orm.WithRowScope(func(ctx context.Context) (query.Condition, bool, error) {
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
	testdb.Migrate(t, app, "rs_item_attachments")
	tenant := uuid.New()
	bg := context.Background()
	t.Cleanup(func() { _, _ = app.DB.Exec(bg, `DELETE FROM rs_item_attachments WHERE tenant_id = $1`, tenant) })
	insert := func(owner string) uuid.UUID {
		var id uuid.UUID
		if err := app.DB.QueryRow(bg, `INSERT INTO rs_item_attachments (tenant_id, owner) VALUES ($1, $2) RETURNING id`, tenant, owner).Scan(&id); err != nil {
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

func TestAttachments_HiddenAnchor404(t *testing.T) {
	f := newScopeFixture(t)
	hiddenRow := Attachment{TableName: "rs_item_attachments", RecordID: f.hidden, Field: "doc"}
	store := &stubAttachments{found: hiddenRow}
	objects := &stubObjects{}
	h := NewHandler(store, objects).WithRowScope(f.app.DB)
	id := map[string]string{"id": uuid.NewString()}
	upload := func(rid uuid.UUID) int {
		body, ct := multipartUpload(t, map[string]string{"table_name": "rs_item_attachments", "record_id": rid.String(), "field": "doc"}, "d.txt", "text/plain", []byte("x"))
		return serve(t, f.as(h.Upload, false), http.MethodPost, "/x", ct, body, f.identity, nil).Code
	}
	if c := upload(f.hidden); c != 404 || len(objects.putKeys) != 0 || store.created != nil {
		t.Errorf("Upload hidden = %d puts=%v, want 404 and nothing stored", c, objects.putKeys)
	}
	find := func(rid uuid.UUID, failing bool) int {
		return serve(t, f.as(h.Find, failing), http.MethodGet, "/x?table=rs_item_attachments&field=doc&record="+rid.String(), "", nil, f.identity, nil).Code
	}
	if c := find(f.hidden, false); c != 404 {
		t.Errorf("Find hidden = %d", c)
	}
	want(t, "Get hidden", serve(t, f.as(h.Get, false), http.MethodGet, "/x", "", nil, f.identity, id), 404)
	want(t, "Delete hidden", serve(t, f.as(h.Delete, false), http.MethodDelete, "/x", "", nil, f.identity, id), 404)
	if store.deletedID != uuid.Nil || len(objects.deletedKeys) != 0 {
		t.Error("Delete hidden removed data")
	}
	if c := upload(f.visible); c != 201 {
		t.Errorf("Upload visible = %d, want 201", c)
	}
	store.anchorErr = orm.ErrNotFound
	if c := find(f.visible, false); c != 404 {
		t.Errorf("Find visible without file = %d (existing 404)", c)
	}
	if c := find(f.visible, true); c != 500 {
		t.Errorf("Find with failing scope = %d, want 500 (not 404)", c)
	}
}

func TestAttachments_UnscopedTableUnchanged(t *testing.T) {
	f := newScopeFixture(t)
	store := &stubAttachments{anchor: Attachment{}}
	h := NewHandler(store, &stubObjects{}).WithRowScope(f.app.DB)
	rec := serve(t, f.as(h.Find, false), http.MethodGet, "/x?table=plain_table&field=doc&record="+uuid.NewString(), "", nil, f.identity, nil)
	want(t, "Find unscoped", rec, 200)
}
