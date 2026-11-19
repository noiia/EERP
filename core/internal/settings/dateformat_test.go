package settings

import (
	"encoding/json"
	"net/http"
	"testing"

	"core/internal/auth"

	"github.com/google/uuid"
)

func TestPutDateFormatSettings(t *testing.T) {
	identity := auth.Identity{UserID: uuid.New(), TenantID: uuid.New()}
	tests := []struct {
		name       string
		body       string
		wantStatus int
		wantValue  string
	}{
		{name: "day first", body: `{"date_format":"dd/MM/yyyy"}`, wantStatus: http.StatusNoContent, wantValue: "dd/MM/yyyy"},
		{name: "month first with dashes", body: `{"date_format":"MM-dd-yyyy"}`, wantStatus: http.StatusNoContent, wantValue: "MM-dd-yyyy"},
		{name: "null resets", body: `{"date_format":null}`, wantStatus: http.StatusNoContent, wantValue: ""},
		{name: "free pattern refused", body: `{"date_format":"EEEE d MMMM"}`, wantStatus: http.StatusBadRequest},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := &stubStore{}
			h := NewHandler(&stubUsers{}, store, &stubCompanies{}, "development")
			rec := serve(t, h.PutDateFormatSettings, http.MethodPut, "/settings/format/date", tt.body, identity)
			if rec.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d; body = %s", rec.Code, tt.wantStatus, rec.Body.String())
			}
			if tt.wantStatus != http.StatusNoContent {
				if store.setCalled {
					t.Fatal("a refused format must not be stored")
				}
				return
			}
			if store.gotKey != DateFormatKey || store.gotValue != tt.wantValue {
				t.Errorf("stored %q = %q, want %q = %q", store.gotKey, store.gotValue, DateFormatKey, tt.wantValue)
			}
		})
	}
}

func TestGetMyPreferences_DateFormat(t *testing.T) {
	identity := auth.Identity{UserID: uuid.New(), TenantID: uuid.New()}
	for name, tc := range map[string]struct {
		stored map[string]string
		want   any
	}{
		"unset reads null":          {stored: nil, want: nil},
		"set reads back":            {stored: map[string]string{DateFormatKey: "yyyy-MM-dd"}, want: "yyyy-MM-dd"},
		"unknown stored reads null": {stored: map[string]string{DateFormatKey: "junk"}, want: nil},
	} {
		t.Run(name, func(t *testing.T) {
			h := NewHandler(&stubUsers{}, &stubStore{values: tc.stored}, &stubCompanies{}, "development")
			rec := serve(t, h.GetMyPreferences, http.MethodGet, "/me/preferences", "", identity)
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d; body = %s", rec.Code, rec.Body.String())
			}
			var resp map[string]any
			if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
				t.Fatal(err)
			}
			if resp["date_format"] != tc.want {
				t.Errorf("date_format = %v, want %v", resp["date_format"], tc.want)
			}
		})
	}
}
