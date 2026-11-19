package auth

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"core/internal/auth"
	"core/internal/testdb"
	"core/orm"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

// rightsCall runs one RightsHandler method as `tenant`, with an optional :id.
func rightsCall(t *testing.T, h echo.HandlerFunc, method, id, body string, tenant uuid.UUID) (int, map[string]any) {
	t.Helper()
	e := echo.New()
	req := httptest.NewRequest(method, "/", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(auth.SetIdentity(req.Context(), auth.Identity{UserID: uuid.New(), TenantID: tenant}))
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	if id != "" {
		c.SetPathValues(echo.PathValues{{Name: "id", Value: id}})
	}
	if err := h(c); err != nil {
		t.Logf("handler error: %v", err)
		e.HTTPErrorHandler(c, err)
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

// newRole inserts a role of `tenant` (role_permissions references it).
func newRole(t *testing.T, db *orm.App, tenant uuid.UUID) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := db.DB.QueryRow(context.Background(), `INSERT INTO roles (tenant_id, name, description) VALUES ($1, $2, '') RETURNING id`,
		tenant, "test-"+uuid.NewString()[:8]).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func newRightsFixture(t *testing.T) (*RightsHandler, *orm.App, uuid.UUID) {
	t.Helper()
	if err := (&authModule{}).Register(); err != nil {
		t.Fatalf("register: %v", err)
	}
	db := testdb.Open(t)
	testdb.MigrateModules(t, db, "auth")
	tenant := uuid.New()
	t.Cleanup(func() {
		ctx := context.Background()
		_, _ = db.DB.Exec(ctx, `DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE tenant_id = $1)`, tenant)
		for _, table := range []string{"role_view_permission_right", "role_view_permission", "account_role_types", "roles"} {
			_, _ = db.DB.Exec(ctx, `DELETE FROM `+table+` WHERE tenant_id = $1`, tenant)
		}
	})
	return NewRightsHandler(db.DB, auth.NewPermissionRepository(db.DB)), db, tenant
}

func TestRightsHandler_RefusesWhatItCannotApply(t *testing.T) {
	h, db, tenant := newRightsFixture(t)
	other := uuid.New() // another tenant never sees this tenant's rows
	role := newRole(t, db, tenant)

	code, view := rightsCall(t, h.CreateViewPermission, http.MethodPost, "", `{"role_id":"`+role.String()+`","entity":"crm"}`, tenant)
	if code != http.StatusCreated {
		t.Fatalf("create view: %d %v", code, view)
	}
	viewID, _ := view["id"].(string)

	cases := []struct {
		name string
		call echo.HandlerFunc
		verb string
		id   string
		body string
		as   uuid.UUID
		want int
	}{
		{"create view: malformed body", h.CreateViewPermission, http.MethodPost, "", `{`, tenant, http.StatusBadRequest},
		{"update view: bad id", h.UpdateViewPermission, http.MethodPut, "nope", `{}`, tenant, http.StatusBadRequest},
		{"update view: unknown id", h.UpdateViewPermission, http.MethodPut, uuid.NewString(), `{}`, tenant, http.StatusNotFound},
		{"update view: other tenant", h.UpdateViewPermission, http.MethodPut, viewID, `{}`, other, http.StatusNotFound},
		{"update view: malformed body", h.UpdateViewPermission, http.MethodPut, viewID, `{`, tenant, http.StatusBadRequest},
		{"delete view: bad id", h.DeleteViewPermission, http.MethodDelete, "nope", "", tenant, http.StatusBadRequest},
		{"delete view: unknown id", h.DeleteViewPermission, http.MethodDelete, uuid.NewString(), "", tenant, http.StatusNotFound},
		{"create right: malformed body", h.CreateRight, http.MethodPost, "", `{`, tenant, http.StatusBadRequest},
		{"create right: unknown view", h.CreateRight, http.MethodPost, "", `{"role_view_permission_id":"` + uuid.NewString() + `"}`, tenant, http.StatusBadRequest},
		{"create right: other tenant's view", h.CreateRight, http.MethodPost, "", `{"role_view_permission_id":"` + viewID + `"}`, other, http.StatusBadRequest},
		{"delete right: bad id", h.DeleteRight, http.MethodDelete, "nope", "", tenant, http.StatusBadRequest},
		{"delete right: unknown id", h.DeleteRight, http.MethodDelete, uuid.NewString(), "", tenant, http.StatusNotFound},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if code, body := rightsCall(t, tc.call, tc.verb, tc.id, tc.body, tc.as); code != tc.want {
				t.Fatalf("status = %d, want %d (%v)", code, tc.want, body)
			}
		})
	}
}

// Moving a view row to another entity revokes the old entity's grants and
// grants the new one's; deleting a right whose view is gone is a 404.
func TestRightsHandler_MoveViewAndOrphanRight(t *testing.T) {
	h, db, tenant := newRightsFixture(t)
	ctx := context.Background()
	role := newRole(t, db, tenant)

	_, view := rightsCall(t, h.CreateViewPermission, http.MethodPost, "", `{"role_id":"`+role.String()+`","entity":"crm"}`, tenant)
	viewID, _ := view["id"].(string)
	has := func(code string) bool {
		var n int
		if err := db.DB.QueryRow(ctx, `SELECT count(*) FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
			WHERE rp.role_id = $1 AND p.code = $2`, role, code).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n > 0
	}
	if !has("crm:crm:read") {
		t.Fatal("a new view row must grant its default rights")
	}

	if code, body := rightsCall(t, h.UpdateViewPermission, http.MethodPut, viewID, `{"entity":"contact"}`, tenant); code != http.StatusOK {
		t.Fatalf("move view: %d %v", code, body)
	}
	if has("crm:crm:read") || !has("contact:contact:read") {
		t.Fatal("moving the view must revoke crm's grants and grant contact's")
	}

	var rightID uuid.UUID
	if err := db.DB.QueryRow(ctx, `SELECT id FROM role_view_permission_right WHERE role_view_permission_id = $1 LIMIT 1`, viewID).Scan(&rightID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.DB.Exec(ctx, `UPDATE role_view_permission SET deleted_at = now() WHERE id = $1`, viewID); err != nil {
		t.Fatal(err)
	}
	if code, _ := rightsCall(t, h.DeleteRight, http.MethodDelete, rightID.String(), "", tenant); code != http.StatusNotFound {
		t.Fatalf("delete right of a deleted view: %d, want 404", code)
	}
}

// A database that can't be reached is a 500 or an error, never a silent success.
func TestRightsHandler_DatabaseDown(t *testing.T) {
	if err := (&authModule{}).Register(); err != nil {
		t.Fatalf("register: %v", err)
	}
	down := testdb.Closed(t)
	h := NewRightsHandler(down.DB, auth.NewPermissionRepository(down.DB))
	tenant := uuid.New()
	if code, _ := rightsCall(t, h.CreateViewPermission, http.MethodPost, "", `{"role_id":"`+uuid.NewString()+`","entity":"crm"}`, tenant); code != http.StatusInternalServerError {
		t.Fatalf("create view: %d, want 500", code)
	}
	if err := h.BackfillAll(context.Background()); err == nil {
		t.Fatal("BackfillAll on a closed database must fail")
	}
	if err := h.reconcile(context.Background(), uuid.New(), ""); err != nil {
		t.Fatalf("reconcile with no entity is a no-op, got %v", err)
	}
	if err := h.reconcile(context.Background(), uuid.New(), "crm"); err == nil {
		t.Fatal("reconcile on a closed database must fail")
	}
}
