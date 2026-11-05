package graphfield_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"core/internal/auth"
	"core/internal/graphfield"
	"core/internal/testdb"
	_ "core/modules/graphfield" // registers the table + its unique key index for MigrateModules

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

func call(t *testing.T, h echo.HandlerFunc, method, target, id, body string, who auth.Identity) (int, map[string]any) {
	t.Helper()
	e := echo.New()
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(auth.SetIdentity(req.Context(), who))
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	if id != "" {
		c.SetPathValues(echo.PathValues{{Name: "id", Value: id}})
	}
	if err := h(c); err != nil {
		e.HTTPErrorHandler(c, err)
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func TestGraphFieldHandler(t *testing.T) {
	db := testdb.Open(t)
	testdb.MigrateModules(t, db, "graphfield")
	tenant := uuid.New()
	t.Cleanup(func() {
		_, _ = db.DB.Exec(context.Background(), `DELETE FROM graph_field WHERE tenant_id = $1`, tenant)
	})
	h := graphfield.NewHandler(graphfield.NewRepository(db.DB))
	hr := auth.Identity{UserID: uuid.New(), TenantID: tenant, Roles: []string{"hr"}}
	sales := auth.Identity{UserID: uuid.New(), TenantID: tenant, Roles: []string{"sales"}}

	create := `{"entity":"crm","key":"calc_margin","label":"Margin","formula":"price - cost","roles":["hr"]}`
	code, created := call(t, h.Create, http.MethodPost, "/", "", create, hr)
	if code != http.StatusCreated {
		t.Fatalf("create: %d %v", code, created)
	}
	fid, _ := created["id"].(string)

	refusals := []struct {
		name string
		call echo.HandlerFunc
		verb string
		id   string
		body string
		who  auth.Identity
		want int
	}{
		{"duplicate key", h.Create, http.MethodPost, "", create, hr, http.StatusConflict},
		{"create: malformed body", h.Create, http.MethodPost, "", `{`, hr, http.StatusBadRequest},
		{"create: bad entity", h.Create, http.MethodPost, "", `{"entity":"CRM;","key":"calc_x","label":"X","formula":"1"}`, hr, http.StatusBadRequest},
		{"create: bad key", h.Create, http.MethodPost, "", `{"entity":"crm","key":"margin","label":"X","formula":"1"}`, hr, http.StatusBadRequest},
		{"create: no label", h.Create, http.MethodPost, "", `{"entity":"crm","key":"calc_x","label":"","formula":"1"}`, hr, http.StatusBadRequest},
		{"create: bad formula", h.Create, http.MethodPost, "", `{"entity":"crm","key":"calc_x","label":"X","formula":"price; DROP"}`, hr, http.StatusBadRequest},
		{"create: bad role", h.Create, http.MethodPost, "", `{"entity":"crm","key":"calc_x","label":"X","formula":"1","roles":["a b"]}`, hr, http.StatusBadRequest},
		{"update: bad id", h.Update, http.MethodPut, "nope", `{}`, hr, http.StatusBadRequest},
		{"update: malformed body", h.Update, http.MethodPut, fid, `{`, hr, http.StatusBadRequest},
		{"update: invalid body", h.Update, http.MethodPut, fid, `{"label":"","formula":"1"}`, hr, http.StatusBadRequest},
		{"update: unknown id", h.Update, http.MethodPut, uuid.NewString(), `{"label":"X","formula":"1"}`, hr, http.StatusNotFound},
		{"update: hidden by roles", h.Update, http.MethodPut, fid, `{"label":"X","formula":"1"}`, sales, http.StatusNotFound},
		{"delete: bad id", h.Delete, http.MethodDelete, "nope", "", hr, http.StatusBadRequest},
		{"delete: unknown id", h.Delete, http.MethodDelete, uuid.NewString(), "", hr, http.StatusNotFound},
		{"delete: hidden by roles", h.Delete, http.MethodDelete, fid, "", sales, http.StatusNotFound},
		{"list: bad entity", h.List, http.MethodGet, "", "", hr, http.StatusBadRequest},
	}
	for _, tc := range refusals {
		t.Run(tc.name, func(t *testing.T) {
			target := "/"
			if tc.name == "list: bad entity" {
				target = "/?entity=Bad!"
			}
			if code, body := call(t, tc.call, tc.verb, target, tc.id, tc.body, tc.who); code != tc.want {
				t.Fatalf("status = %d, want %d (%v)", code, tc.want, body)
			}
		})
	}

	t.Run("list shows a field only to its roles", func(t *testing.T) {
		_, mine := call(t, h.List, http.MethodGet, "/?entity=crm", "", "", hr)
		_, theirs := call(t, h.List, http.MethodGet, "/?entity=crm", "", "", sales)
		if mine["total"] != float64(1) || theirs["total"] != float64(0) {
			t.Fatalf("hr sees %v, sales sees %v; want 1 and 0", mine["total"], theirs["total"])
		}
	})

	t.Run("update keeps the key, delete frees it", func(t *testing.T) {
		code, updated := call(t, h.Update, http.MethodPut, "/", fid, `{"label":"Net margin","formula":"price - cost - tax","roles":[],"dated":true}`, hr)
		if code != http.StatusOK || updated["key"] != "calc_margin" || updated["label"] != "Net margin" {
			t.Fatalf("update: %d %v", code, updated)
		}
		if code, _ := call(t, h.Delete, http.MethodDelete, "/", fid, "", sales); code != http.StatusNoContent {
			t.Fatalf("delete (now visible to everyone): %d", code)
		}
		if code, _ := call(t, h.Create, http.MethodPost, "/", "", create, hr); code != http.StatusCreated {
			t.Fatalf("the key must be reusable after a delete, got %d", code)
		}
	})
}

func TestGraphFieldHandler_DatabaseDown(t *testing.T) {
	down := testdb.Closed(t)
	h := graphfield.NewHandler(graphfield.NewRepository(down.DB))
	who := auth.Identity{UserID: uuid.New(), TenantID: uuid.New()}
	for name, run := range map[string]func() int{
		"list": func() int { c, _ := call(t, h.List, http.MethodGet, "/?entity=crm", "", "", who); return c },
		"create": func() int {
			c, _ := call(t, h.Create, http.MethodPost, "/", "", `{"entity":"crm","key":"calc_x","label":"X","formula":"1"}`, who)
			return c
		},
		"update": func() int {
			c, _ := call(t, h.Update, http.MethodPut, "/", uuid.NewString(), `{"label":"X","formula":"1"}`, who)
			return c
		},
		"delete": func() int { c, _ := call(t, h.Delete, http.MethodDelete, "/", uuid.NewString(), "", who); return c },
	} {
		t.Run(name, func(t *testing.T) {
			if code := run(); code != http.StatusInternalServerError {
				t.Fatalf("status = %d, want 500", code)
			}
		})
	}
}
