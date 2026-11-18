package mcpbridge

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"core/internal/auth"
	authmw "core/internal/middleware"
	"core/internal/types"
	"core/orm"
	"core/orm/model"
	"core/orm/server"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
	"github.com/labstack/echo/v5/middleware"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type testPermissions struct{ fail bool }

func (p testPermissions) Has(_ context.Context, roles []string, permission string) (bool, error) {
	if p.fail {
		return false, errors.New("database detail must not escape")
	}
	for _, r := range roles {
		if r == "admin" || (r == "reader" && strings.HasSuffix(permission, ":read")) {
			return true, nil
		}
	}
	return false, nil
}

type testFixture struct {
	e      *echo.Echo
	b      *Bridge
	tokens *auth.TokenService
}

type testProject struct {
	model.BaseModel
	TenantID uuid.UUID `db:"tenant_id"`
	Name     string    `db:"name"`
}

func fixture(t *testing.T, writes bool) *testFixture {
	t.Helper()
	if err := orm.Register[testProject](orm.WithTableName("project")); err != nil {
		t.Fatal(err)
	}
	e := echo.New()
	e.Use(middleware.CORSWithConfig(middleware.CORSConfig{AllowOrigins: []string{"*"}})) // hostile preflight must be rejected before this
	cfg := &types.Config{MasterPassword: strings.Repeat("s", 48), MCPAllowWrites: writes,
		MCPAllowedOrigins: []string{"https://trusted.example"}, MCPRateLimitPerMinute: 10000}
	tokens := auth.NewTokenService(cfg)
	jwt := authmw.JWTMiddleware(tokens)
	perms := testPermissions{}
	g := e.Group("/api/v1/project", jwt, authmw.PermissionMiddleware(perms))
	g.GET("", func(c *echo.Context) error {
		id := auth.MustIdentity(c.Request().Context())
		return c.JSON(200, map[string]any{"data": []any{}, "total": 0, "tenant": id.TenantID, "user": id.UserID, "page": c.QueryParam("page")})
	})
	g.GET("/:id", func(c *echo.Context) error {
		if c.Param("id") == "hidden" {
			return c.JSON(404, map[string]string{"error": "not found"})
		}
		return c.JSON(200, map[string]string{"id": c.Param("id")})
	})
	g.GET("/directory", func(c *echo.Context) error { return c.JSON(200, "static route") })
	g.GET("/:id/metrics", func(c *echo.Context) error { return c.JSON(200, map[string]any{"spi": 0.8}) })
	g.GET("/:id/schedule", func(c *echo.Context) error { return c.JSON(200, map[string]any{"critical_path": []string{"task"}}) })
	g.POST("", func(c *echo.Context) error {
		var data map[string]any
		if err := c.Bind(&data); err != nil {
			return err
		}
		data["computed_by_business_handler"] = true
		return c.JSON(201, data)
	})
	g.DELETE("/:id", func(c *echo.Context) error { return c.NoContent(204) })
	g.GET("/:id/file", func(c *echo.Context) error { return c.Blob(200, "application/pdf", []byte("%PDF-test")) })
	g.GET("/:id/error", func(c *echo.Context) error { return c.JSON(500, map[string]string{"error": "private SQL detail"}) })
	g.GET("/:id/large", func(c *echo.Context) error {
		return c.Blob(200, "text/plain", bytes.Repeat([]byte("x"), maxResponseBytes+1))
	})
	e.POST("/api/v1/attachments", func(c *echo.Context) error {
		file, err := c.FormFile("file")
		if err != nil {
			return err
		}
		return c.JSON(201, map[string]any{"name": file.Filename, "table": c.FormValue("table_name"), "type": file.Header.Get("Content-Type")})
	}, jwt)
	for _, path := range []string{"/api/v1/auth/login", "/api/v1/public/data", "/api/v1/database-management/databases", "/api/v1/website/me", "/api/v1/dev_seed", "/api/v1/unknown"} {
		e.GET(path, func(c *echo.Context) error { return c.JSON(200, "must not be exposed") })
	}
	b := New(e, perms, nil, writes, nil)
	b.models = func(context.Context) []server.APIModel {
		return []server.APIModel{{Name: "project", Route: "project", Fields: []server.APIField{}}}
	}
	b.Mount(e, cfg, jwt)
	return &testFixture{e, b, tokens}
}

func (f *testFixture) token(t *testing.T, role string, tenant, user uuid.UUID, website, forced bool) string {
	t.Helper()
	u := auth.Users{}
	u.ID = user
	u.TenantID = tenant
	u.MustChangePassword = forced
	if website {
		u.Kind = auth.KindWebsite
	}
	token, err := f.tokens.IssueAccess(u, []string{role}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	return token
}

func (f *testFixture) rpc(t *testing.T, token, method string, params any) (int, map[string]any) {
	t.Helper()
	data, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest("POST", Path, bytes.NewReader(data))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("MCP-Protocol-Version", "2025-11-25")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	f.e.ServeHTTP(rec, req)
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("HTTP %d invalid JSON: %s", rec.Code, rec.Body.String())
	}
	return rec.Code, out
}

func (f *testFixture) call(t *testing.T, token, tool string, args any) map[string]any {
	t.Helper()
	code, out := f.rpc(t, token, "tools/call", map[string]any{"name": tool, "arguments": args})
	if code != 200 {
		t.Fatalf("call %s: HTTP %d: %v", tool, code, out)
	}
	result, ok := out["result"].(map[string]any)
	if !ok {
		t.Fatalf("call %s: %v", tool, out)
	}
	return result
}

func structured(t *testing.T, result map[string]any) map[string]any {
	t.Helper()
	if result["isError"] == true {
		t.Fatalf("tool failed: %v", result)
	}
	out, ok := result["structuredContent"].(map[string]any)
	if !ok {
		t.Fatalf("missing structured content: %v", result)
	}
	return out
}

func TestProtocolDiscoveryAndTools(t *testing.T) {
	f := fixture(t, true)
	token := f.token(t, "admin", uuid.New(), uuid.New(), false, false)
	code, init := f.rpc(t, token, "initialize", map[string]any{"protocolVersion": "2025-11-25", "capabilities": map[string]any{}, "clientInfo": map[string]string{"name": "test", "version": "1"}})
	if code != 200 || init["result"] == nil {
		t.Fatalf("initialize: %d %v", code, init)
	}
	for _, method := range []string{"ping", "tools/list", "resources/list", "resources/templates/list", "prompts/list"} {
		code, out := f.rpc(t, token, method, map[string]any{})
		if code != 200 || out["error"] != nil {
			t.Errorf("%s: %d %v", method, code, out)
		}
	}
	models := structured(t, f.call(t, token, "eerp_list_models", map[string]any{}))
	if models["total"] != float64(1) {
		t.Fatalf("models: %v", models)
	}
	result := structured(t, f.call(t, token, "eerp_create_record", map[string]any{"model": "project", "data": map[string]any{"name": "New project"}}))
	if result["status"] != float64(201) || result["data"].(map[string]any)["computed_by_business_handler"] != true {
		t.Fatalf("override not used: %v", result)
	}
	for _, section := range []string{"record", "metrics", "schedule"} {
		structured(t, f.call(t, token, "eerp_get_project", map[string]any{"id": uuid.NewString(), "section": section}))
	}
	result = f.call(t, token, "eerp_get_record", map[string]any{"model": "project", "id": "hidden"})
	if result["isError"] != true || result["structuredContent"].(map[string]any)["status"] != float64(404) {
		t.Fatalf("API errors lost: %v", result)
	}
	result = structured(t, f.call(t, token, "eerp_delete_record", map[string]any{"model": "project", "id": uuid.NewString()}))
	if result["status"] != float64(204) {
		t.Fatalf("delete: %v", result)
	}
}

func TestAuthenticationAndOrigins(t *testing.T) {
	f := fixture(t, true)
	refresh, err := f.tokens.IssueRefresh(uuid.New())
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, token string
		status      int
	}{
		{"absent", "", 401}, {"invalid", "bad", 401},
		{"refresh token", refresh, 401},
		{"visitor", f.token(t, "admin", uuid.New(), uuid.New(), true, false), 403},
		{"password change", f.token(t, "admin", uuid.New(), uuid.New(), false, true), 403},
	} {
		t.Run(tc.name, func(t *testing.T) {
			code, _ := f.rpc(t, tc.token, "tools/list", map[string]any{})
			if code != tc.status {
				t.Fatalf("got %d want %d", code, tc.status)
			}
		})
	}
	token := f.token(t, "reader", uuid.New(), uuid.New(), false, false)
	for _, method := range []string{"POST", "OPTIONS", "GET", "DELETE"} {
		for _, origin := range []string{"https://evil.example", "null", "https://trusted.example.evil", ""} {
			req := httptest.NewRequest(method, Path, nil)
			req.Header["Origin"] = []string{origin}
			req.Header.Set("Authorization", "Bearer "+token)
			rec := httptest.NewRecorder()
			f.e.ServeHTTP(rec, req)
			if rec.Code != 403 {
				t.Errorf("%s Origin %q: %d", method, origin, rec.Code)
			}
		}
	}
	req := httptest.NewRequest("OPTIONS", Path, nil)
	req.Header.Set("Origin", "https://trusted.example")
	req.Header.Set("Access-Control-Request-Method", "POST")
	rec := httptest.NewRecorder()
	f.e.ServeHTTP(rec, req)
	if rec.Code != 204 {
		t.Fatalf("trusted preflight: %d", rec.Code)
	}
	for _, method := range []string{"GET", "DELETE"} {
		req := httptest.NewRequest(method, Path, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()
		f.e.ServeHTTP(rec, req)
		if rec.Code != 405 {
			t.Errorf("stateless %s: %d", method, rec.Code)
		}
	}
}

func TestReadOnlyAndPermissions(t *testing.T) {
	for _, writes := range []bool{false, true} {
		f := fixture(t, writes)
		token := f.token(t, "reader", uuid.New(), uuid.New(), false, false)
		out := f.call(t, token, "eerp_read_operation", map[string]any{"operation": "POST /api/v1/project"})
		if out["isError"] != true {
			t.Fatal("read tool performed a write")
		}
		_, listing := f.rpc(t, token, "tools/list", map[string]any{})
		serialized, _ := json.Marshal(listing)
		if strings.Contains(string(serialized), "eerp_write_operation") != writes {
			t.Fatalf("wrong write tools: %s", serialized)
		}
		if writes {
			out = f.call(t, token, "eerp_write_operation", map[string]any{"operation": "POST /api/v1/project", "body": map[string]any{"name": "forbidden"}})
			if out["isError"] != true || out["structuredContent"].(map[string]any)["status"] != float64(403) {
				t.Fatalf("permission middleware bypassed: %v", out)
			}
		}
		for _, op := range f.b.catalog("") {
			if !writes && !op.ReadOnly {
				t.Fatal("write advertised in read-only mode")
			}
			for _, excluded := range []string{"auth/", "public/", "database-management/", "website/", "dev_seed", "unknown", "/mcp"} {
				if strings.Contains(op.ID, excluded) {
					t.Fatalf("unsafe operation %s", op.ID)
				}
			}
		}
	}
}

func TestConcurrentRequestIdentityIsolation(t *testing.T) {
	f := fixture(t, false)
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		tenant, user := uuid.New(), uuid.New()
		token := f.token(t, "reader", tenant, user, false, false)
		wg.Go(func() {
			result := structured(t, f.call(t, token, "eerp_list_projects", map[string]any{"query": map[string]string{"page": "3"}}))
			data := result["data"].(map[string]any)
			if data["tenant"] != tenant.String() || data["user"] != user.String() || data["page"] != "3" {
				t.Errorf("identity leaked: %v", data)
			}
		})
	}
	wg.Wait()
}

func TestFilesAndErrorBounds(t *testing.T) {
	f := fixture(t, true)
	token := f.token(t, "admin", uuid.New(), uuid.New(), false, false)
	out := structured(t, f.call(t, token, "eerp_write_operation", map[string]any{
		"operation": "POST /api/v1/attachments", "form": map[string]string{"table_name": "project"},
		"files": []Upload{{Field: "file", Name: "rapport été.pdf", MIMEType: "application/pdf", Base64: base64.StdEncoding.EncodeToString([]byte("PDF"))}},
	}))
	if out["data"].(map[string]any)["type"] != "application/pdf" {
		t.Fatalf("upload: %v", out)
	}
	if out["data"].(map[string]any)["name"] != "rapport été.pdf" {
		t.Fatalf("filename: %v", out)
	}
	out = structured(t, f.call(t, token, "eerp_read_operation", map[string]any{"operation": "GET /api/v1/project/:id/file", "path_params": map[string]string{"id": "p"}}))
	if out["base64"] != base64.StdEncoding.EncodeToString([]byte("%PDF-test")) {
		t.Fatalf("binary: %v", out)
	}
	for _, suffix := range []string{"error", "large"} {
		out := f.call(t, token, "eerp_read_operation", map[string]any{"operation": "GET /api/v1/project/:id/" + suffix, "path_params": map[string]string{"id": "p"}})
		encoded, _ := json.Marshal(out)
		if out["isError"] != true || strings.Contains(string(encoded), "private SQL detail") {
			t.Fatalf("bad error: %s", encoded)
		}
	}
	for _, id := range []string{"..", "a/b", "%2f", "a?b", "directory"} {
		out := f.call(t, token, "eerp_get_record", map[string]any{"model": "project", "id": id})
		if out["isError"] != true {
			t.Errorf("accepted invalid/ambiguous id %q: %v", id, out)
		}
	}
	for _, input := range []Request{
		{Body: map[string]any{}, Form: map[string]string{}},
		{Form: map[string]string{"bad\r\nContent-Type": "injection"}},
		{Files: []Upload{{Field: "file", Name: "a", MIMEType: "text/plain", Base64: "%%%"}}},
		{Files: []Upload{{Field: "file", Name: "a", MIMEType: "x\r\ny: z", Base64: ""}}},
		{Body: map[string]any{"large": strings.Repeat("x", maxRequestBytes)}},
	} {
		if _, _, err := requestBody(input); err == nil {
			t.Fatal("accepted invalid upload/body")
		}
	}
}

type bearerTransport struct{ token string }

func (t bearerTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+t.token)
	return http.DefaultTransport.RoundTrip(r)
}

func TestOfficialClientInteropResourcesAndPrompts(t *testing.T) {
	f := fixture(t, false)
	token := f.token(t, "reader", uuid.New(), uuid.New(), false, false)
	httpServer := httptest.NewServer(f.e)
	defer httpServer.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	client := mcp.NewClient(&mcp.Implementation{Name: "integration", Version: "1"}, nil)
	session, err := client.Connect(ctx, &mcp.StreamableClientTransport{Endpoint: httpServer.URL + Path, HTTPClient: &http.Client{Transport: bearerTransport{token}}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	if _, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "eerp_list_projects", Arguments: map[string]any{}}); err != nil {
		t.Fatal(err)
	}
	for _, uri := range []string{"eerp://guide", "eerp://models/project"} {
		if _, err := session.ReadResource(ctx, &mcp.ReadResourceParams{URI: uri}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := session.GetPrompt(ctx, &mcp.GetPromptParams{Name: "eerp_review_project", Arguments: map[string]string{"project_id": uuid.NewString()}}); err != nil {
		t.Fatal(err)
	}
}

func TestConfigAndPagination(t *testing.T) {
	for _, origin := range []string{"*", "null", "https://*.example", "https://example/", "https://u:p@example", "https://example?", "https://example#", "file:///tmp"} {
		if err := ValidateConfig(&types.Config{MCPAllowedOrigins: []string{origin}}); err == nil {
			t.Errorf("accepted %q", origin)
		}
	}
	if err := ValidateConfig(&types.Config{MCPAllowedOrigins: []string{"https://example:443", "http://localhost:3000"}}); err != nil {
		t.Fatal(err)
	}
	if err := ValidateConfig(&types.Config{MCPRateLimitPerMinute: -1}); err == nil {
		t.Fatal("negative rate")
	}
	for _, in := range []CatalogInput{{Offset: -1}, {Limit: 201}, {Limit: -1}} {
		if _, err := page([]string{}, in); err == nil {
			t.Fatalf("accepted %v", in)
		}
	}
	result, err := page([]int{1, 2}, CatalogInput{Offset: 100})
	if err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(result.(map[string]any)["data"]) != "[]" {
		t.Fatal(result)
	}
}

func TestRequestLimitsAndUnavailableModels(t *testing.T) {
	f := fixture(t, true)
	tenant, user := uuid.New(), uuid.New()
	token := f.token(t, "admin", tenant, user, false, false)
	if out := f.call(t, token, "eerp_list_projects", map[string]any{"query": map[string]string{"page_size": "1000000"}}); out["isError"] != true {
		t.Fatal("unbounded database page admitted")
	}
	// The HTTP body limit applies before parsing and executing any tool.
	req := httptest.NewRequest("POST", Path, strings.NewReader(strings.Repeat("x", maxRequestBytes+1)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	f.e.ServeHTTP(rec, req)
	if rec.Code != 413 {
		t.Fatalf("oversized request: %d", rec.Code)
	}
	u := auth.Users{}
	u.ID = user
	u.TenantID = tenant
	expired, err := f.tokens.IssueAccessWithTTL(u, []string{"admin"}, nil, nil, -time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if code, _ := f.rpc(t, expired, "tools/list", map[string]any{}); code != 401 {
		t.Fatalf("expired token: %d", code)
	}
	f.b.isActive = func(string) bool { return false }
	models := structured(t, f.call(t, token, "eerp_list_models", map[string]any{}))
	if models["total"] != float64(0) {
		t.Fatalf("inactive model exposed: %v", models)
	}
	if out := f.call(t, token, "eerp_describe_model", map[string]string{"model": "project"}); out["isError"] != true {
		t.Fatal("inactive schema exposed")
	}
	f.b.isActive = nil
	f.b.perms = testPermissions{fail: true}
	if out := f.call(t, token, "eerp_list_models", map[string]any{}); out["isError"] != true {
		t.Fatal("permission service failure admitted")
	}
	// Saturation is rejected before the API can start a mutation.
	for i := 0; i < cap(f.b.slots); i++ {
		f.b.slots <- struct{}{}
	}
	if out := f.call(t, token, "eerp_create_record", map[string]any{"model": "project", "data": map[string]any{"name": "must not start"}}); out["isError"] != true {
		t.Fatal("saturated operation admitted")
	}
	for len(f.b.slots) > 0 {
		<-f.b.slots
	}
	ctx := context.WithValue(auth.SetIdentity(context.Background(), auth.Identity{UserID: user, TenantID: tenant}), callerKey{}, caller{authorization: "Bearer " + token})
	ctx, cancel := context.WithCancel(ctx)
	cancel()
	started := false
	f.b.api = http.HandlerFunc(func(http.ResponseWriter, *http.Request) { started = true })
	if _, err := f.b.execute(ctx, Request{Operation: "POST /api/v1/project", Body: map[string]any{"name": "cancelled"}}, true); err == nil || started {
		t.Fatal("cancelled mutation started")
	}
}

func TestMCPRateLimit(t *testing.T) {
	e := echo.New()
	cfg := &types.Config{MasterPassword: strings.Repeat("k", 48), MCPRateLimitPerMinute: 1}
	tokens := auth.NewTokenService(cfg)
	b := New(e, testPermissions{}, nil, false, nil)
	b.Mount(e, cfg, authmw.JWTMiddleware(tokens))
	f := &testFixture{e: e, b: b, tokens: tokens}
	token := f.token(t, "reader", uuid.New(), uuid.New(), false, false)
	if code, _ := f.rpc(t, token, "tools/list", map[string]any{}); code != 200 {
		t.Fatalf("first request: %d", code)
	}
	if code, _ := f.rpc(t, token, "tools/list", map[string]any{}); code != 429 {
		t.Fatalf("rate limit: %d", code)
	}
}
