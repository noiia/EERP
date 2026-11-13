package settings_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"core/internal/auth"
	"core/internal/settings"
	"core/internal/testdb"
	_ "core/modules/auth"
	_ "core/modules/settings"
	"core/orm"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

func layoutCall(t *testing.T, h echo.HandlerFunc, method, entity, mode, body string, id auth.Identity) *httptest.ResponseRecorder {
	t.Helper()
	e := echo.New()
	req := httptest.NewRequest(method, "/", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(auth.SetIdentity(req.Context(), id))
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetPathValues(echo.PathValues{{Name: "entity", Value: entity}, {Name: "mode", Value: mode}})
	if err := h(c); err != nil {
		e.HTTPErrorHandler(c, err)
	}
	return rec
}

func layoutApp(t *testing.T) *orm.App {
	app := testdb.Open(t)
	testdb.MigrateModules(t, app, "auth", "settings")
	return app
}

func newID() auth.Identity { return auth.Identity{UserID: uuid.New(), TenantID: uuid.New()} }

func TestViewLayout_EmptyDefault(t *testing.T) {
	h := settings.NewViewLayoutHandler(layoutApp(t).DB)
	rec := layoutCall(t, h.Get, "GET", "project_task", "wbs", "", newID())
	if rec.Code != 200 || strings.TrimSpace(rec.Body.String()) != `{"positions":{},"folded":[]}` {
		t.Fatalf("got %d %s", rec.Code, rec.Body)
	}
}

func TestViewLayout_RoundTripAndReplace(t *testing.T) {
	app := layoutApp(t)
	h := settings.NewViewLayoutHandler(app.DB)
	id := newID()
	for _, body := range []string{
		`{"positions":{"a":{"x":1,"y":2}},"folded":["a"]}`,
		`{"positions":{"b":{"x":-3.5,"y":4}},"folded":[]}`,
		`{"positions":{"n1":{"x":0,"y":0}},"folded":[],"notes":[{"id":"n1","text":"why","links":["b"]}]}`,
	} {
		if rec := layoutCall(t, h.Put, "PUT", "project_task", "pert", body, id); rec.Code != 204 {
			t.Fatalf("put %d %s", rec.Code, rec.Body)
		}
		rec := layoutCall(t, h.Get, "GET", "project_task", "pert", "", id)
		var got, want any
		_ = json.Unmarshal(rec.Body.Bytes(), &got)
		_ = json.Unmarshal([]byte(body), &want)
		if rec.Code != 200 || !equalJSON(got, want) {
			t.Fatalf("get %d %s, want %s", rec.Code, rec.Body, body)
		}
	}
	var n int
	if err := app.DB.QueryRow(t.Context(), `SELECT count(*) FROM user_view_layout WHERE tenant_id=$1`, id.TenantID).Scan(&n); err != nil || n != 1 {
		t.Fatalf("rows = %d, err %v", n, err)
	}
}

func equalJSON(a, b any) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return string(x) == string(y)
}

func TestViewLayout_OwnRowOnly(t *testing.T) {
	h := settings.NewViewLayoutHandler(layoutApp(t).DB)
	u1 := newID()
	layoutCall(t, h.Put, "PUT", "project_task", "wbs", `{"positions":{"a":{"x":1,"y":2}},"folded":[]}`, u1)
	empty := `{"positions":{},"folded":[]}`
	for name, id := range map[string]auth.Identity{
		"other user":   {UserID: uuid.New(), TenantID: u1.TenantID},
		"other tenant": {UserID: u1.UserID, TenantID: uuid.New()},
	} {
		t.Run(name, func(t *testing.T) {
			rec := layoutCall(t, h.Get, "GET", "project_task", "wbs", "", id)
			if strings.TrimSpace(rec.Body.String()) != empty {
				t.Fatalf("leaked: %s", rec.Body)
			}
		})
	}
}

func TestViewLayout_Limits(t *testing.T) {
	app := layoutApp(t)
	h := settings.NewViewLayoutHandler(app.DB)
	ids := make([]string, 5001)
	pos := make([]string, 5001)
	for i := range ids {
		ids[i] = fmt.Sprintf(`"id%d"`, i)
		pos[i] = ids[i] + `:{"x":0,"y":0}`
	}
	tests := []struct{ name, entity, mode, body string }{
		{"bad mode", "project_task", "gantt", `{}`},
		{"bad entity", "Bad-Name", "wbs", `{}`},
		{"too many positions", "project_task", "wbs", `{"positions":{` + strings.Join(pos, ",") + `}}`},
		{"long id", "project_task", "wbs", `{"positions":{"` + strings.Repeat("a", 301) + `":{"x":0,"y":0}}}`},
		{"x out of range", "project_task", "wbs", `{"positions":{"a":{"x":1e7,"y":0}}}`},
		{"overflow number", "project_task", "wbs", `{"positions":{"a":{"x":1e309,"y":0}}}`},
		{"too many folded", "project_task", "wbs", `{"folded":[` + strings.Join(ids, ",") + `]}`},
		{"note without id", "project_task", "pert", `{"notes":[{"id":"","text":"x","links":[]}]}`},
		{"long note", "project_task", "pert", `{"notes":[{"id":"n","text":"` + strings.Repeat("a", 2001) + `","links":[]}]}`},
		{"bad note link", "project_task", "pert", `{"notes":[{"id":"n","text":"x","links":[""]}]}`},
		{"too many notes", "project_task", "pert", `{"notes":[` + strings.Repeat(`{"id":"n","text":"","links":[]},`, 200) + `{"id":"n","text":"","links":[]}]}`},
	}
	// A WBS saves its group roots too: 2000 tasks plus their groups must fit.
	t.Run("at the limit", func(t *testing.T) {
		body := `{"positions":{` + strings.Join(pos[:5000], ",") + `},"folded":[` + strings.Join(ids[:5000], ",") + `]}`
		if rec := layoutCall(t, h.Put, "PUT", "project_task", "wbs", body, newID()); rec.Code != 204 {
			t.Fatalf("status %d %s, want 204", rec.Code, rec.Body)
		}
	})
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			id := newID()
			rec := layoutCall(t, h.Put, "PUT", tc.entity, tc.mode, tc.body, id)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status %d, want 400", rec.Code)
			}
			if strings.Count(rec.Body.String(), `"error"`) != 1 {
				t.Fatalf("expected one error response, got %s", rec.Body)
			}
			var n int
			if err := app.DB.QueryRow(t.Context(), `SELECT count(*) FROM user_view_layout WHERE tenant_id=$1 AND user_id=$2`, id.TenantID, id.UserID).Scan(&n); err != nil || n != 0 {
				t.Fatalf("persisted rows = %d, err %v", n, err)
			}
		})
	}
}

func TestViewLayout_DBError(t *testing.T) {
	h := settings.NewViewLayoutHandler(testdb.Closed(t).DB)
	for _, m := range []string{"GET", "PUT"} {
		hf := h.Get
		if m == "PUT" {
			hf = h.Put
		}
		if rec := layoutCall(t, hf, m, "project_task", "wbs", `{}`, newID()); rec.Code != 500 {
			t.Fatalf("%s status %d, want 500", m, rec.Code)
		}
	}
}
