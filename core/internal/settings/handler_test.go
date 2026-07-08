package settings

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"core/internal/auth"
	"core/orm"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
)

// ── Stubs ─────────────────────────────────────────────────────────────────────

type stubUsers struct {
	user      auth.Users
	findErr   error
	setErr    error
	setCalled bool
	gotUserID uuid.UUID
	gotLocale *string
}

func (s *stubUsers) FindByID(_ context.Context, _ uuid.UUID) (auth.Users, error) {
	return s.user, s.findErr
}

func (s *stubUsers) SetPreferredLocale(_ context.Context, userID uuid.UUID, locale *string) error {
	s.setCalled = true
	s.gotUserID = userID
	s.gotLocale = locale
	return s.setErr
}

type stubStore struct {
	// values holds per-key stored settings (GetMyPreferences reads several keys).
	values    map[string]string
	getErr    error
	setErr    error
	setCalled bool
	gotTenant uuid.UUID
	gotKey    string
	gotValue  string
}

func (s *stubStore) Get(_ context.Context, _ uuid.UUID, key string) (string, bool, error) {
	value, ok := s.values[key]
	return value, ok, s.getErr
}

func (s *stubStore) Set(_ context.Context, tenantID uuid.UUID, key, value string) error {
	s.setCalled = true
	s.gotTenant = tenantID
	s.gotKey = key
	s.gotValue = value
	return s.setErr
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func serve(t *testing.T, h echo.HandlerFunc, method, target, body string, identity auth.Identity) *httptest.ResponseRecorder {
	t.Helper()
	e := echo.New()
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(auth.SetIdentity(req.Context(), identity))
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	if err := h(c); err != nil {
		e.HTTPErrorHandler(err, c)
	}
	return rec
}

func strPtr(s string) *string { return &s }

// ── GET /me/preferences ───────────────────────────────────────────────────────

func TestGetMyPreferences(t *testing.T) {
	identity := auth.Identity{UserID: uuid.New(), TenantID: uuid.New()}

	tests := []struct {
		name          string
		users         *stubUsers
		store         *stubStore
		wantStatus    int
		wantPreferred any
		wantDefault   any
		wantFormat    any
	}{
		{
			name:          "no preference, no default",
			users:         &stubUsers{},
			store:         &stubStore{},
			wantStatus:    http.StatusOK,
			wantPreferred: nil,
			wantDefault:   nil,
			wantFormat:    nil,
		},
		{
			name:          "preference and default set",
			users:         &stubUsers{user: auth.Users{PreferredLocale: strPtr("fr")}},
			store:         &stubStore{values: map[string]string{DefaultLocaleKey: "de"}},
			wantStatus:    http.StatusOK,
			wantPreferred: "fr",
			wantDefault:   "de",
			wantFormat:    nil,
		},
		{
			name:          "empty stored default reads as null (source)",
			users:         &stubUsers{},
			store:         &stubStore{values: map[string]string{DefaultLocaleKey: ""}},
			wantStatus:    http.StatusOK,
			wantPreferred: nil,
			wantDefault:   nil,
			wantFormat:    nil,
		},
		{
			name:  "stored number format rides along",
			users: &stubUsers{},
			store: &stubStore{values: map[string]string{
				NumberFormatKey: `{"decimal_separator":",","thousands_separator":" "}`,
			}},
			wantStatus:    http.StatusOK,
			wantPreferred: nil,
			wantDefault:   nil,
			wantFormat:    map[string]any{"decimal_separator": ",", "thousands_separator": " "},
		},
		{
			name:          "unparsable stored format degrades to null",
			users:         &stubUsers{},
			store:         &stubStore{values: map[string]string{NumberFormatKey: "{not json"}},
			wantStatus:    http.StatusOK,
			wantPreferred: nil,
			wantDefault:   nil,
			wantFormat:    nil,
		},
		{
			name:       "user record gone reads as unauthenticated",
			users:      &stubUsers{findErr: orm.ErrNotFound},
			store:      &stubStore{},
			wantStatus: http.StatusUnauthorized,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHandlerWith(tt.users, tt.store)
			rec := serve(t, h.GetMyPreferences, http.MethodGet, "/me/preferences", "", identity)

			if rec.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d; body = %s", rec.Code, tt.wantStatus, rec.Body.String())
			}
			if tt.wantStatus != http.StatusOK {
				return
			}

			var resp map[string]any
			if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			if resp["preferred_locale"] != tt.wantPreferred {
				t.Errorf("preferred_locale = %v, want %v", resp["preferred_locale"], tt.wantPreferred)
			}
			if resp["default_locale"] != tt.wantDefault {
				t.Errorf("default_locale = %v, want %v", resp["default_locale"], tt.wantDefault)
			}
			if !reflect.DeepEqual(resp["number_format"], tt.wantFormat) {
				t.Errorf("number_format = %v, want %v", resp["number_format"], tt.wantFormat)
			}
		})
	}
}

// ── PUT /me/preferences ───────────────────────────────────────────────────────

func TestPutMyPreferences(t *testing.T) {
	identity := auth.Identity{UserID: uuid.New(), TenantID: uuid.New()}

	tests := []struct {
		name       string
		body       string
		setErr     error
		wantStatus int
		wantSet    bool
		wantLocale *string
	}{
		{name: "set a locale", body: `{"preferred_locale":"fr"}`, wantStatus: http.StatusNoContent, wantSet: true, wantLocale: strPtr("fr")},
		{name: "regioned tag accepted", body: `{"preferred_locale":"pt-BR"}`, wantStatus: http.StatusNoContent, wantSet: true, wantLocale: strPtr("pt-BR")},
		{name: "source sentinel accepted", body: `{"preferred_locale":"source"}`, wantStatus: http.StatusNoContent, wantSet: true, wantLocale: strPtr("source")},
		{name: "null clears (inherit default)", body: `{"preferred_locale":null}`, wantStatus: http.StatusNoContent, wantSet: true, wantLocale: nil},
		{name: "junk rejected", body: `{"preferred_locale":"fr; DROP TABLE users"}`, wantStatus: http.StatusBadRequest},
		{name: "overlong rejected", body: `{"preferred_locale":"abcdefghijklmnopqrstuvwxyz"}`, wantStatus: http.StatusBadRequest},
		{name: "user gone reads as unauthenticated", body: `{"preferred_locale":"fr"}`, setErr: orm.ErrNotFound, wantStatus: http.StatusUnauthorized, wantSet: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			users := &stubUsers{setErr: tt.setErr}
			h := newHandlerWith(users, &stubStore{})
			rec := serve(t, h.PutMyPreferences, http.MethodPut, "/me/preferences", tt.body, identity)

			if rec.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d; body = %s", rec.Code, tt.wantStatus, rec.Body.String())
			}
			if users.setCalled != tt.wantSet {
				t.Fatalf("setCalled = %v, want %v", users.setCalled, tt.wantSet)
			}
			if !tt.wantSet || tt.wantStatus != http.StatusNoContent {
				return
			}
			if users.gotUserID != identity.UserID {
				t.Errorf("updated user = %s, want the caller %s", users.gotUserID, identity.UserID)
			}
			switch {
			case tt.wantLocale == nil && users.gotLocale != nil:
				t.Errorf("locale = %q, want nil", *users.gotLocale)
			case tt.wantLocale != nil && (users.gotLocale == nil || *users.gotLocale != *tt.wantLocale):
				t.Errorf("locale = %v, want %q", users.gotLocale, *tt.wantLocale)
			}
		})
	}
}

// ── PUT /settings/i18n ────────────────────────────────────────────────────────

func TestPutI18nSettings(t *testing.T) {
	identity := auth.Identity{UserID: uuid.New(), TenantID: uuid.New()}

	tests := []struct {
		name       string
		body       string
		wantStatus int
		wantSet    bool
		wantValue  string
	}{
		{name: "set default", body: `{"default_locale":"fr"}`, wantStatus: http.StatusNoContent, wantSet: true, wantValue: "fr"},
		{name: "null stores empty (source)", body: `{"default_locale":null}`, wantStatus: http.StatusNoContent, wantSet: true, wantValue: ""},
		{name: "source sentinel rejected for default (null means source)", body: `{"default_locale":"source"}`, wantStatus: http.StatusBadRequest},
		{name: "junk rejected", body: `{"default_locale":"../../etc"}`, wantStatus: http.StatusBadRequest},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := &stubStore{}
			h := newHandlerWith(&stubUsers{}, store)
			rec := serve(t, h.PutI18nSettings, http.MethodPut, "/settings/i18n", tt.body, identity)

			if rec.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d; body = %s", rec.Code, tt.wantStatus, rec.Body.String())
			}
			if store.setCalled != tt.wantSet {
				t.Fatalf("setCalled = %v, want %v", store.setCalled, tt.wantSet)
			}
			if !tt.wantSet {
				return
			}
			if store.gotTenant != identity.TenantID {
				t.Errorf("tenant = %s, want the caller's %s", store.gotTenant, identity.TenantID)
			}
			if store.gotKey != DefaultLocaleKey {
				t.Errorf("key = %q, want %q", store.gotKey, DefaultLocaleKey)
			}
			if store.gotValue != tt.wantValue {
				t.Errorf("value = %q, want %q", store.gotValue, tt.wantValue)
			}
		})
	}
}

// ── PUT /settings/format ──────────────────────────────────────────────────────

func TestPutFormatSettings(t *testing.T) {
	identity := auth.Identity{UserID: uuid.New(), TenantID: uuid.New()}

	tests := []struct {
		name       string
		body       string
		wantStatus int
		wantSet    bool
		wantValue  string
	}{
		{
			name:       "anglo format",
			body:       `{"decimal_separator":".","thousands_separator":","}`,
			wantStatus: http.StatusNoContent,
			wantSet:    true,
			wantValue:  `{"decimal_separator":".","thousands_separator":","}`,
		},
		{
			name:       "european format (comma decimal, space grouping)",
			body:       `{"decimal_separator":",","thousands_separator":" "}`,
			wantStatus: http.StatusNoContent,
			wantSet:    true,
			wantValue:  `{"decimal_separator":",","thousands_separator":" "}`,
		},
		{
			name:       "no grouping accepted",
			body:       `{"decimal_separator":".","thousands_separator":""}`,
			wantStatus: http.StatusNoContent,
			wantSet:    true,
			wantValue:  `{"decimal_separator":".","thousands_separator":""}`,
		},
		{name: "unknown decimal rejected", body: `{"decimal_separator":";","thousands_separator":","}`, wantStatus: http.StatusBadRequest},
		{name: "empty decimal rejected", body: `{"decimal_separator":"","thousands_separator":","}`, wantStatus: http.StatusBadRequest},
		{name: "unknown thousands rejected", body: `{"decimal_separator":".","thousands_separator":"_"}`, wantStatus: http.StatusBadRequest},
		{name: "identical separators rejected", body: `{"decimal_separator":".","thousands_separator":"."}`, wantStatus: http.StatusBadRequest},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := &stubStore{}
			h := newHandlerWith(&stubUsers{}, store)
			rec := serve(t, h.PutFormatSettings, http.MethodPut, "/settings/format", tt.body, identity)

			if rec.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d; body = %s", rec.Code, tt.wantStatus, rec.Body.String())
			}
			if store.setCalled != tt.wantSet {
				t.Fatalf("setCalled = %v, want %v", store.setCalled, tt.wantSet)
			}
			if !tt.wantSet {
				return
			}
			if store.gotTenant != identity.TenantID {
				t.Errorf("tenant = %s, want the caller's %s", store.gotTenant, identity.TenantID)
			}
			if store.gotKey != NumberFormatKey {
				t.Errorf("key = %q, want %q", store.gotKey, NumberFormatKey)
			}
			if store.gotValue != tt.wantValue {
				t.Errorf("value = %q, want %q", store.gotValue, tt.wantValue)
			}
		})
	}
}
