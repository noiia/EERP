package app

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"core/internal/auth"
	"core/internal/common"
	"core/internal/testdb"
	"core/internal/types"
)

func TestMain(m *testing.M) {
	if err := common.InitLogger(false); err != nil {
		panic(err)
	}
	os.Exit(m.Run())
}

func TestBuild_RejectsBadConfig(t *testing.T) {
	badYAML := filepath.Join(t.TempDir(), "api.yaml")
	if err := os.WriteFile(badYAML, []byte("not: [valid"), 0o600); err != nil {
		t.Fatal(err)
	}
	const key = "a-master-key-long-enough-to-sign-jwts-0123456789"
	valid := types.Config{MasterPassword: key, DbPassword: "a-db-password", Environment: "development"}
	with := func(mod func(*types.Config)) types.Config { c := valid; mod(&c); return c }
	tests := []struct {
		name string
		cfg  types.Config
	}{
		{"empty master key", with(func(c *types.Config) { c.MasterPassword = "" })},
		{"template master key", with(func(c *types.Config) { c.MasterPassword = "change-me-in-production" })},
		{"master key leaked in repo history", with(func(c *types.Config) { c.MasterPassword = "ueioiehsiuehfs" })},
		{"master key too short", with(func(c *types.Config) { c.MasterPassword = "short" })},
		{"empty db password", with(func(c *types.Config) { c.DbPassword = "" })},
		{"db password leaked in repo history", with(func(c *types.Config) { c.DbPassword = "postgres" })},
		{"unknown environment", with(func(c *types.Config) { c.Environment = "staging" })},
		{"missing api config file", with(func(c *types.Config) { c.ApiConfigPath = filepath.Join(t.TempDir(), "nope.yaml") })},
		{"malformed api config file", with(func(c *types.Config) { c.ApiConfigPath = badYAML })},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := Build(context.Background(), &tt.cfg, "", false); err == nil {
				t.Fatal("Build succeeded, want an error")
			}
		})
	}
}

// client drives the built app in-process, as the seeded dev admin.
type client struct {
	t     *testing.T
	h     http.Handler
	a     *App
	token string
}

func (c *client) do(method, path string, body any) (int, []byte) {
	c.t.Helper()
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			c.t.Fatal(err)
		}
	}
	req := httptest.NewRequest(method, path, &buf)
	req.Header.Set("Content-Type", "application/json")
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	rec := httptest.NewRecorder()
	c.h.ServeHTTP(rec, req)
	return rec.Code, rec.Body.Bytes()
}

// decode unmarshals a JSON response body into a map.
func decode(t *testing.T, body []byte) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(body, &m); err != nil {
		t.Fatalf("decode %s: %v", body, err)
	}
	return m
}

// buildApp boots the whole backend against the test database, with the dev
// admin seeded, and returns a client logged in as that admin.
func buildApp(t *testing.T) *client {
	t.Helper()
	cfg := testdb.Config(t)
	cfg.Environment = "development" // no forced password change for the seeded admin
	cfg.CronLogDir = t.TempDir()

	a, err := Build(context.Background(), cfg, "", false)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	t.Cleanup(a.Close)

	c := &client{t: t, h: a.Handler(), a: a}
	code, body := c.do(http.MethodPost, "/api/v1/auth/login",
		map[string]string{"email": auth.DevAdminEmail, "password": auth.DevAdminPassword})
	if code != http.StatusOK {
		t.Fatalf("login: %d %s", code, body)
	}
	c.token, _ = decode(t, body)["access_token"].(string)
	return c
}

func TestApp_Routes(t *testing.T) {
	c := buildApp(t)

	tests := []struct {
		method string
		path   string
		body   any
		want   int
	}{
		{http.MethodGet, "/health", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/me/preferences", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/settings/views/crm/fields", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/settings/views/crm/graph", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/settings/views/crm/chatter", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/settings/integrations/osm", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/settings/tax", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/settings/accounts", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/settings/reports/layout", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/modules", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/modules/sale", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/modules/sale/logs", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/views", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/users", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/roles", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/crm", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/invoice", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/quote", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/property_management", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/cron", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/cron_history", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/notebook_pages?table=crm&record=00000000-0000-0000-0000-000000000001", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/saved_filters?entity=crm", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/chatter_messages?table=crm&record=00000000-0000-0000-0000-000000000001", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/nope", nil, http.StatusNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.method+" "+tt.path, func(t *testing.T) {
			if code, body := c.do(tt.method, tt.path, tt.body); code != tt.want {
				t.Errorf("status = %d, want %d: %s", code, tt.want, body)
			}
		})
	}

	t.Run("no token is rejected", func(t *testing.T) {
		anon := &client{t: t, h: c.h}
		if code, _ := anon.do(http.MethodGet, "/api/v1/crm", nil); code != http.StatusUnauthorized {
			t.Errorf("status = %d, want 401", code)
		}
	})
}
