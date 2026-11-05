package settings

import (
	"errors"
	"net/http"
	"testing"

	"core/internal/auth"
	"core/internal/company"
	"core/orm"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

// Every settings handler against each way its dependencies can fail: a body that
// isn't JSON is a 400, and an unreadable/unwritable store or an unresolvable
// active company is a 500 — never a silent 2xx that would make the frontend
// believe a setting was saved.
func TestSettingsHandlers_FailurePaths(t *testing.T) {
	boom := errors.New("database down")
	identity := auth.Identity{UserID: uuid.New(), TenantID: uuid.New()}

	type route struct {
		name   string
		method string
		param  string // the path param's name ("entity"/"module"), "" when none
		body   string // a valid body for PUTs; "" for GETs
		call   func(h *Handler) echo.HandlerFunc
	}
	routes := []route{
		{"GetMyPreferences", http.MethodGet, "", "", func(h *Handler) echo.HandlerFunc { return h.GetMyPreferences }},
		{"PutI18nSettings", http.MethodPut, "", `{"default_locale":"fr"}`, func(h *Handler) echo.HandlerFunc { return h.PutI18nSettings }},
		{"PutFormatSettings", http.MethodPut, "", `{"decimal_separator":".","thousands_separator":","}`, func(h *Handler) echo.HandlerFunc { return h.PutFormatSettings }},
		{"PutDateFormatSettings", http.MethodPut, "", `{"date_format":"dd/MM/yyyy"}`, func(h *Handler) echo.HandlerFunc { return h.PutDateFormatSettings }},
		{"GetViewFieldsSettings", http.MethodGet, "entity", "", func(h *Handler) echo.HandlerFunc { return h.GetViewFieldsSettings }},
		{"PutViewFieldsSettings", http.MethodPut, "entity", `{"kanban_status_field":"status"}`, func(h *Handler) echo.HandlerFunc { return h.PutViewFieldsSettings }},
		{"GetChatterSettings", http.MethodGet, "entity", "", func(h *Handler) echo.HandlerFunc { return h.GetChatterSettings }},
		{"PutChatterSettings", http.MethodPut, "entity", `{"enabled":false}`, func(h *Handler) echo.HandlerFunc { return h.PutChatterSettings }},
		{"GetStatusBarSettings", http.MethodGet, "entity", "", func(h *Handler) echo.HandlerFunc { return h.GetStatusBarSettings }},
		{"PutStatusBarSettings", http.MethodPut, "entity", `{"field":"status","steps":["a","b"]}`, func(h *Handler) echo.HandlerFunc { return h.PutStatusBarSettings }},
		{"GetGraphLayoutSettings", http.MethodGet, "entity", "", func(h *Handler) echo.HandlerFunc { return h.GetGraphLayoutSettings }},
		{"PutGraphLayoutSettings", http.MethodPut, "entity", `{"tiles":[{"id":"t1","x":0,"y":0,"w":6,"h":6,"type":"stat"}]}`, func(h *Handler) echo.HandlerFunc { return h.PutGraphLayoutSettings }},
		{"GetPictureSizeSettings", http.MethodGet, "module", "", func(h *Handler) echo.HandlerFunc { return h.GetPictureSizeSettings }},
		{"PutPictureSizeSettings", http.MethodPut, "module", `{"size":{"width":200,"height":150}}`, func(h *Handler) echo.HandlerFunc { return h.PutPictureSizeSettings }},
		{"GetReportsLayoutSettings", http.MethodGet, "", "", func(h *Handler) echo.HandlerFunc { return h.GetReportsLayoutSettings }},
		{"PutReportsLayoutSettings", http.MethodPut, "", `{"footer":"Thanks","address":"1 Main St"}`, func(h *Handler) echo.HandlerFunc { return h.PutReportsLayoutSettings }},
		{"GetAccountsSettings", http.MethodGet, "", "", func(h *Handler) echo.HandlerFunc { return h.GetAccountsSettings }},
		{"PutAccountsSettings", http.MethodPut, "", `{"username_at_format":true}`, func(h *Handler) echo.HandlerFunc { return h.PutAccountsSettings }},
		{"GetTaxSettings", http.MethodGet, "", "", func(h *Handler) echo.HandlerFunc { return h.GetTaxSettings }},
		{"PutTaxSettings", http.MethodPut, "", `{"price_mode":"tax_included"}`, func(h *Handler) echo.HandlerFunc { return h.PutTaxSettings }},
		{"GetUnitSettings", http.MethodGet, "", "", func(h *Handler) echo.HandlerFunc { return h.GetUnitSettings }},
		{"PutUnitSettings", http.MethodPut, "", `{"system":"imperial"}`, func(h *Handler) echo.HandlerFunc { return h.PutUnitSettings }},
		{"GetOSMSettings", http.MethodGet, "", "", func(h *Handler) echo.HandlerFunc { return h.GetOSMSettings }},
		{"PutOSMSettings", http.MethodPut, "", `{"enabled":true,"base_url":"https://nominatim.openstreetmap.org","user_agent":"eerp-test"}`, func(h *Handler) echo.HandlerFunc { return h.PutOSMSettings }},
	}

	do := func(t *testing.T, r route, h *Handler, body string) int {
		t.Helper()
		target := "/settings"
		if r.param == "" {
			return serve(t, r.call(h), r.method, target, body, identity).Code
		}
		return serveWithParam(t, r.call(h), r.method, target, body, identity, r.param, "crm").Code
	}

	for _, r := range routes {
		t.Run(r.name, func(t *testing.T) {
			if r.method == http.MethodPut {
				t.Run("malformed body", func(t *testing.T) {
					h := NewHandler(&stubUsers{}, &stubStore{}, &stubCompanies{}, "test")
					if code := do(t, r, h, `{not json`); code != http.StatusBadRequest {
						t.Fatalf("status = %d, want 400", code)
					}
				})
				t.Run("write fails", func(t *testing.T) {
					h := NewHandler(&stubUsers{}, &stubStore{setErr: boom}, &stubCompanies{}, "test")
					if code := do(t, r, h, r.body); code != http.StatusInternalServerError {
						t.Fatalf("status = %d, want 500", code)
					}
				})
			} else {
				t.Run("read fails", func(t *testing.T) {
					h := NewHandler(&stubUsers{}, &stubStore{getErr: boom}, &stubCompanies{}, "test")
					if code := do(t, r, h, ""); code != http.StatusInternalServerError {
						t.Fatalf("status = %d, want 500", code)
					}
				})
			}
			t.Run("active company unresolvable", func(t *testing.T) {
				h := NewHandler(&stubUsers{}, &stubStore{}, &stubCompanies{resolveErr: boom}, "test")
				if code := do(t, r, h, r.body); code != http.StatusInternalServerError {
					t.Fatalf("status = %d, want 500", code)
				}
			})
		})
	}
}

func TestPutMyPreferences_FailurePaths(t *testing.T) {
	boom := errors.New("database down")
	identity := auth.Identity{UserID: uuid.New(), TenantID: uuid.New()}
	cases := []struct {
		name      string
		users     *stubUsers
		companies *stubCompanies
		body      string
		want      int
	}{
		{"malformed body", &stubUsers{}, &stubCompanies{}, `{not json`, http.StatusBadRequest},
		{"locale write fails", &stubUsers{setErr: boom}, &stubCompanies{}, `{"preferred_locale":"fr"}`, http.StatusInternalServerError},
		{"company lookup fails", &stubUsers{}, &stubCompanies{findErr: boom}, `{"active_company_id":"` + uuid.NewString() + `"}`, http.StatusInternalServerError},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := NewHandler(tc.users, &stubStore{}, tc.companies, "test")
			if code := serve(t, h.PutMyPreferences, http.MethodPut, "/me/preferences", tc.body, identity).Code; code != tc.want {
				t.Fatalf("status = %d, want %d", code, tc.want)
			}
		})
	}

	t.Run("active company write fails, or the user is gone", func(t *testing.T) {
		own := uuid.New()
		for _, tc := range []struct {
			err  error
			want int
		}{{boom, http.StatusInternalServerError}, {orm.ErrNotFound, http.StatusUnauthorized}} {
			companies := &stubCompanies{byID: map[uuid.UUID]company.Company{own: {ID: own}}}
			h := NewHandler(&stubUsers{setActiveErr: tc.err}, &stubStore{}, companies, "test")
			if code := serve(t, h.PutMyPreferences, http.MethodPut, "/me/preferences", `{"active_company_id":"`+own.String()+`"}`, identity).Code; code != tc.want {
				t.Fatalf("status = %d, want %d", code, tc.want)
			}
		}
	})
}
