package mcpoauth_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"core/internal/auth"
	. "core/internal/mcpoauth"
	authmw "core/internal/middleware"
	"core/internal/testdb"
	"core/internal/types"
	_ "core/modules/auth"
	"core/orm"
	"core/orm/model"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

const (
	testIssuer   = "https://erp.test"
	testRedirect = "https://claude.ai/api/mcp/auth_callback"
	testVerifier = "verifier-0123456789-0123456789-0123456789-abcdef"
)

func challengeOf(v string) string {
	sum := sha256.Sum256([]byte(v))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// fixture is a handler over the test database with a CIMD document served by a
// local TLS server, two staff users in two tenants and a website visitor.
type fixture struct {
	t                 *testing.T
	db                *orm.DB
	h                 *Handler
	e                 *echo.Echo
	tokens            *auth.TokenService
	cimd              string // the CIMD client_id URL
	doc               *string
	tenant, other     uuid.UUID
	alice, bob, guest uuid.UUID // alice: staff of tenant; bob: staff of other; guest: website visitor of tenant
	registeredClients []string
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	app := testdb.Open(t)
	testdb.MigrateModules(t, app, "auth")
	ctx := context.Background()
	f := &fixture{t: t, db: app.DB, tenant: uuid.New(), other: uuid.New(), alice: uuid.New(), bob: uuid.New(), guest: uuid.New()}
	cfg := &types.Config{MasterPassword: "test-master-key-for-mcp-oauth", AccessTTLSeconds: 21600}
	f.tokens = auth.NewTokenService(cfg)

	doc := ""
	f.doc = &doc
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/redirect":
			http.Redirect(w, r, "/client.json", http.StatusFound)
		case "/big":
			_, _ = w.Write(bytes.Repeat([]byte(" "), MetadataMaxBytes+10))
		default:
			_, _ = w.Write([]byte(*f.doc))
		}
	}))
	t.Cleanup(srv.Close)
	f.cimd = srv.URL + "/client.json"
	doc = fmt.Sprintf(`{"client_id":%q,"client_name":"Claude","redirect_uris":[%q],"token_endpoint_auth_method":"none"}`, f.cimd, testRedirect)

	s := Settings{Issuer: testIssuer, TrustedHosts: map[string]bool{"claude.ai": true, "127.0.0.1": true}}
	store := NewStore(app.DB)
	f.h = NewHandler(s, store, f.tokens, auth.NewUserRepository(app.DB), auth.NewPermissionRepository(app.DB), time.Hour*6, 7*24*time.Hour)
	// The local TLS server is on a loopback address, which the production
	// client refuses (tested on its own below): trust its certificate instead.
	f.h.UseMetadataClient(srv.Client())
	f.e = echo.New()
	f.e.HTTPErrorHandler = func(c *echo.Context, err error) {
		t.Logf("handler error: %v", err)
		_ = c.JSON(http.StatusInternalServerError, map[string]string{"message": err.Error()})
	}
	f.h.Mount(f.e, authmw.JWTMiddleware(f.tokens), 10000, 10000)

	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := app.DB.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}
	exec(`INSERT INTO users (id, tenant_id, email) VALUES ($1, $2, $3), ($4, $5, $6)`,
		f.alice, f.tenant, uuid.NewString()+"@t.example", f.bob, f.other, uuid.NewString()+"@t.example")
	exec(`INSERT INTO users (id, tenant_id, email, kind) VALUES ($1, $2, $3, 'website')`, f.guest, f.tenant, uuid.NewString()+"@t.example")
	t.Cleanup(func() {
		ids := []uuid.UUID{f.tenant, f.other}
		_, _ = app.DB.Exec(ctx, `DELETE FROM oauth_grant WHERE tenant_id = ANY($1)`, ids)
		_, _ = app.DB.Exec(ctx, `DELETE FROM oauth_code WHERE tenant_id = ANY($1)`, ids)
		_, _ = app.DB.Exec(ctx, `DELETE FROM oauth_client WHERE client_id = ANY($1)`, f.registeredClients)
		_, _ = app.DB.Exec(ctx, `DELETE FROM users WHERE tenant_id = ANY($1)`, ids)
	})
	return f
}

// session is an ERP (or website) access token for user.
func (f *fixture) session(user, tenant uuid.UUID, kind string) string {
	f.t.Helper()
	tok, err := f.tokens.IssueAccess(auth.Users{Kind: kind, BaseModel: model.BaseModel{ID: user, TenantID: tenant}}, nil, nil, nil)
	if err != nil {
		f.t.Fatal(err)
	}
	return tok
}

func (f *fixture) call(method, path, token, contentType, body string) (int, map[string]any, http.Header) {
	f.t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	f.e.ServeHTTP(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out, rec.Header()
}

func authParams(clientID string, over map[string]string) map[string]string {
	p := map[string]string{"client_id": clientID, "redirect_uri": testRedirect, "response_type": "code",
		"code_challenge": challengeOf(testVerifier), "code_challenge_method": "S256", "state": "xyz",
		"resource": testIssuer + MCPPath}
	for k, v := range over {
		if v == "-" {
			delete(p, k)
		} else {
			p[k] = v
		}
	}
	return p
}

// approve runs the consent page's POST as user and returns the redirect URL.
func (f *fixture) approve(token string, params map[string]string, approve bool) (int, map[string]any) {
	f.t.Helper()
	body, _ := json.Marshal(map[string]any{"params": params, "approve": approve})
	code, out, _ := f.call("POST", "/api/v1/oauth/authorize", token, "application/json", string(body))
	return code, out
}

// codeFor approves for alice and returns the code.
func (f *fixture) codeFor(clientID string) string {
	f.t.Helper()
	code, out := f.approve(f.session(f.alice, f.tenant, ""), authParams(clientID, nil), true)
	if code != 200 {
		f.t.Fatalf("approve: %d %v", code, out)
	}
	u, err := url.Parse(out["redirect_to"].(string))
	if err != nil || !strings.HasPrefix(out["redirect_to"].(string), testRedirect+"?") {
		f.t.Fatalf("redirect_to %v", out["redirect_to"])
	}
	if u.Query().Get("state") != "xyz" || u.Query().Get("iss") != testIssuer {
		f.t.Fatalf("redirect query %v", u.Query())
	}
	return u.Query().Get("code")
}

func (f *fixture) token(form url.Values) (int, map[string]any) {
	f.t.Helper()
	code, out, h := f.call("POST", "/api/v1/oauth/token", "", "application/x-www-form-urlencoded", form.Encode())
	if h.Get("Cache-Control") != "no-store" {
		f.t.Errorf("token response Cache-Control = %q, want no-store", h.Get("Cache-Control"))
	}
	return code, out
}

func (f *fixture) exchange(clientID, code, verifier, redirect string) (int, map[string]any) {
	return f.token(url.Values{"grant_type": {"authorization_code"}, "client_id": {clientID}, "code": {code},
		"code_verifier": {verifier}, "redirect_uri": {redirect}, "resource": {testIssuer + MCPPath}})
}

func wantOAuthError(t *testing.T, code int, out map[string]any, status int, errCode string) {
	t.Helper()
	if code != status || out["error"] != errCode {
		t.Errorf("got %d %v, want %d %s", code, out, status, errCode)
	}
}

func (f *fixture) live(out map[string]any) bool {
	f.t.Helper()
	claims, err := f.tokens.ParseAccess(out["access_token"].(string))
	if err != nil {
		f.t.Fatal(err)
	}
	ok, err := f.h.GrantLive(context.Background(), claims.GrantID, claims.Sub)
	if err != nil {
		f.t.Fatal(err)
	}
	return ok
}

func TestMetadata(t *testing.T) {
	f := newFixture(t)
	for _, p := range []string{"/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/api/v1/mcp", "/api/v1/oauth/metadata/protected-resource"} {
		code, out, _ := f.call("GET", p, "", "", "")
		if code != 200 || out["resource"] != testIssuer+MCPPath || fmt.Sprint(out["authorization_servers"]) != "["+testIssuer+"]" {
			t.Errorf("%s: %d %v", p, code, out)
		}
	}
	for _, p := range []string{"/.well-known/oauth-authorization-server", "/api/v1/oauth/metadata/authorization-server"} {
		code, out, _ := f.call("GET", p, "", "", "")
		if code != 200 || out["issuer"] != testIssuer || out["authorization_endpoint"] != testIssuer+"/app/oauth/authorize" ||
			out["token_endpoint"] != testIssuer+"/api/v1/oauth/token" || out["client_id_metadata_document_supported"] != true ||
			fmt.Sprint(out["code_challenge_methods_supported"]) != "[S256]" || fmt.Sprint(out["token_endpoint_auth_methods_supported"]) != "[none]" {
			t.Errorf("%s: %d %v", p, code, out)
		}
	}
}

func TestAuthorizationCodeFlow(t *testing.T) {
	f := newFixture(t)
	alice := f.session(f.alice, f.tenant, "")

	t.Run("the consent page reads the client", func(t *testing.T) {
		q := url.Values{}
		for k, v := range authParams(f.cimd, nil) {
			q.Set(k, v)
		}
		code, out, _ := f.call("GET", "/api/v1/oauth/authorize?"+q.Encode(), alice, "", "")
		if code != 200 || out["client_name"] != "Claude" || out["client_host"] != "127.0.0.1" || out["redirect_uri"] != testRedirect {
			t.Fatalf("check: %d %v", code, out)
		}
	})

	t.Run("a wrong PKCE verifier burns the code", func(t *testing.T) {
		c := f.codeFor(f.cimd)
		code, out := f.exchange(f.cimd, c, "wrong-verifier-0123456789-0123456789-0123456789", testRedirect)
		wantOAuthError(t, code, out, 400, "invalid_grant")
		code, out = f.exchange(f.cimd, c, testVerifier, testRedirect)
		wantOAuthError(t, code, out, 400, "invalid_grant")
	})

	t.Run("a missing verifier, another redirect URI or another client are refused", func(t *testing.T) {
		for name, try := range map[string][3]string{
			"no verifier":    {f.cimd, "", testRedirect},
			"other redirect": {f.cimd, testVerifier, "https://claude.ai/other"},
			"other client":   {"https://claude.ai/other.json", testVerifier, testRedirect},
		} {
			code, out := f.exchange(try[0], f.codeFor(f.cimd), try[1], try[2])
			if code != 400 || out["error"] != "invalid_grant" {
				t.Errorf("%s: %d %v", name, code, out)
			}
		}
	})

	t.Run("a good exchange, then a replayed code revokes its grant", func(t *testing.T) {
		c := f.codeFor(f.cimd)
		code, out := f.exchange(f.cimd, c, testVerifier, testRedirect)
		if code != 200 || out["token_type"] != "Bearer" || out["refresh_token"] == "" || out["expires_in"] != float64(3600) {
			t.Fatalf("exchange: %d %v", code, out)
		}
		claims, err := f.tokens.ParseAccess(out["access_token"].(string))
		if err != nil || !claims.IsMCP() || claims.Sub != f.alice || claims.Tenant != f.tenant || claims.GrantID == uuid.Nil {
			t.Fatalf("claims %+v %v", claims, err)
		}
		if !f.live(out) {
			t.Fatal("the new grant is not live")
		}
		code2, out2 := f.exchange(f.cimd, c, testVerifier, testRedirect)
		wantOAuthError(t, code2, out2, 400, "invalid_grant")
		if f.live(out) {
			t.Error("a replayed code left its grant live")
		}
	})

	t.Run("an expired code is refused", func(t *testing.T) {
		c := f.codeFor(f.cimd)
		if _, err := f.db.Exec(context.Background(), `UPDATE oauth_code SET expires_at = now() - interval '1 minute' WHERE code_hash = $1`, HashToken(c)); err != nil {
			t.Fatal(err)
		}
		code, out := f.exchange(f.cimd, c, testVerifier, testRedirect)
		wantOAuthError(t, code, out, 400, "invalid_grant")
	})

	t.Run("declining sends access_denied back", func(t *testing.T) {
		code, out := f.approve(alice, authParams(f.cimd, nil), false)
		if code != 200 || !strings.Contains(out["redirect_to"].(string), "error=access_denied") || !strings.Contains(out["redirect_to"].(string), "state=xyz") {
			t.Fatalf("deny: %d %v", code, out)
		}
	})
}

func TestAuthorizeRefusals(t *testing.T) {
	f := newFixture(t)
	alice := f.session(f.alice, f.tenant, "")
	cases := []struct {
		name     string
		params   map[string]string
		errCode  string
		redirect bool // the error may go back to the client
	}{
		{"unregistered redirect URI", authParams(f.cimd, map[string]string{"redirect_uri": "https://claude.ai/elsewhere"}), "invalid_request", false},
		{"no redirect URI", authParams(f.cimd, map[string]string{"redirect_uri": "-"}), "invalid_request", false},
		{"client on an untrusted host", authParams("https://evil.example/client.json", nil), "invalid_client", false},
		{"http client metadata URL", authParams(strings.Replace(f.cimd, "https://", "http://", 1), nil), "invalid_client", false},
		{"unknown registered client", authParams("eerp-nope", nil), "invalid_client", false},
		{"no PKCE", authParams(f.cimd, map[string]string{"code_challenge": "-"}), "invalid_request", true},
		{"plain PKCE", authParams(f.cimd, map[string]string{"code_challenge_method": "plain"}), "invalid_request", true},
		{"another resource", authParams(f.cimd, map[string]string{"resource": "https://other.example/mcp"}), "invalid_target", true},
		{"another response type", authParams(f.cimd, map[string]string{"response_type": "token"}), "unsupported_response_type", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			code, out := f.approve(alice, tc.params, true)
			if code != 200 || out["ok"] != false || out["error"] != tc.errCode {
				t.Fatalf("%d %v, want ok=false %s", code, out, tc.errCode)
			}
			to, has := out["redirect_to"].(string)
			if has != tc.redirect || (has && !strings.HasPrefix(to, testRedirect+"?")) {
				t.Errorf("redirect_to = %q, want present=%v", to, tc.redirect)
			}
		})
	}
	t.Run("a website visitor can't authorize", func(t *testing.T) {
		code, _ := f.approve(f.session(f.guest, f.tenant, auth.KindWebsite), authParams(f.cimd, nil), true)
		if code != 403 {
			t.Errorf("website session: %d, want 403", code)
		}
	})
	t.Run("an MCP token can't authorize another app", func(t *testing.T) {
		_, out := f.exchange(f.cimd, f.codeFor(f.cimd), testVerifier, testRedirect)
		code, _ := f.approve(out["access_token"].(string), authParams(f.cimd, nil), true)
		if code != 403 {
			t.Errorf("MCP token on the consent route: %d, want 403", code)
		}
	})
	t.Run("signed out", func(t *testing.T) {
		if code, _ := f.approve("", authParams(f.cimd, nil), true); code != 401 {
			t.Errorf("no session: %d, want 401", code)
		}
	})
}

func TestClientMetadataDocument(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	base := strings.TrimSuffix(f.cimd, "/client.json")
	t.Run("redirects are not followed, oversized documents refused", func(t *testing.T) {
		for _, path := range []string{"/redirect", "/big"} {
			if _, err := f.h.ResolveClient(ctx, base+path); err == nil {
				t.Errorf("%s accepted", path)
			}
		}
	})
	t.Run("the document must name itself and trusted https redirects", func(t *testing.T) {
		// %[1]q is the document's own URL, %[2]q the trusted callback.
		for name, doc := range map[string]string{
			"other-client-id":     `{"client_id":"https://claude.ai/x","redirect_uris":[%[2]q]}`,
			"untrusted-redirect":  `{"client_id":%[1]q,"redirect_uris":["https://evil.example/cb"]}`,
			"http-redirect":       `{"client_id":%[1]q,"redirect_uris":["http://claude.ai/cb"]}`,
			"confidential-client": `{"client_id":%[1]q,"redirect_uris":[%[2]q],"token_endpoint_auth_method":"client_secret_basic","token_endpoint_auth_methods_supported":["client_secret_basic"]}`,
			"no-redirect":         `{"client_id":%[1]q}`,
		} {
			id := base + "/" + name
			*f.doc = fmt.Sprintf(doc, id, testRedirect)
			if _, err := f.h.ResolveClient(ctx, id); err == nil {
				t.Errorf("%s accepted", name)
			}
		}
	})
	t.Run("a client preferring private_key_jwt but able to be public is accepted (ChatGPT)", func(t *testing.T) {
		id := base + "/chatgpt.json"
		*f.doc = fmt.Sprintf(`{"client_id":%q,"client_name":"ChatGPT","redirect_uris":[%q],"token_endpoint_auth_method":"private_key_jwt",
			"token_endpoint_auth_methods_supported":["none","private_key_jwt"],"grant_types":["authorization_code","refresh_token","urn:ietf:params:oauth:grant-type:jwt-bearer"]}`, id, testRedirect)
		info, err := f.h.ResolveClient(ctx, id)
		if err != nil || info.Name != "ChatGPT" {
			t.Fatalf("ChatGPT-shaped document refused: %+v %v", info, err)
		}
	})
	t.Run("the production client refuses private addresses", func(t *testing.T) {
		_, err := f.h.ResolveWithProductionClient(ctx, f.cimd)
		if err == nil || !strings.Contains(err.Error(), "refusing") {
			t.Errorf("loopback fetch: %v", err)
		}
	})
}

func TestDynamicRegistration(t *testing.T) {
	f := newFixture(t)
	code, out, _ := f.call("POST", "/api/v1/oauth/register", "", "application/json",
		`{"redirect_uris":["https://evil.example/cb"],"client_name":"x"}`)
	wantOAuthError(t, code, out, 400, "invalid_redirect_uri")
	// A client asking for another auth method or grant is registered public anyway.
	code, out, _ = f.call("POST", "/api/v1/oauth/register", "", "application/json",
		`{"redirect_uris":["`+testRedirect+`"],"client_name":"x","token_endpoint_auth_method":"private_key_jwt","grant_types":["authorization_code","urn:ietf:params:oauth:grant-type:jwt-bearer"]}`)
	if code != 201 || out["token_endpoint_auth_method"] != "none" || fmt.Sprint(out["grant_types"]) != "[authorization_code refresh_token]" {
		t.Fatalf("register private_key_jwt: %d %v", code, out)
	}
	f.registeredClients = append(f.registeredClients, out["client_id"].(string))

	code, out, _ = f.call("POST", "/api/v1/oauth/register", "", "application/json",
		`{"redirect_uris":["`+testRedirect+`"],"client_name":"ChatGPT","grant_types":["authorization_code","refresh_token"]}`)
	if code != 201 || out["token_endpoint_auth_method"] != "none" {
		t.Fatalf("register: %d %v", code, out)
	}
	clientID := out["client_id"].(string)
	f.registeredClients = append(f.registeredClients, clientID)
	code, out = f.exchange(clientID, f.codeFor(clientID), testVerifier, testRedirect)
	if code != 200 || out["access_token"] == nil {
		t.Fatalf("registered client exchange: %d %v", code, out)
	}
}

func TestRefreshRotation(t *testing.T) {
	f := newFixture(t)
	_, first := f.exchange(f.cimd, f.codeFor(f.cimd), testVerifier, testRedirect)
	refresh := func(token string) (int, map[string]any) {
		return f.token(url.Values{"grant_type": {"refresh_token"}, "client_id": {f.cimd}, "refresh_token": {token}})
	}
	if code, out := f.token(url.Values{"grant_type": {"refresh_token"}, "client_id": {"https://claude.ai/other.json"}, "refresh_token": {first["refresh_token"].(string)}}); code != 400 || out["error"] != "invalid_grant" {
		t.Errorf("another client's refresh: %d %v", code, out)
	}
	code, second := refresh(first["refresh_token"].(string))
	if code != 200 || second["refresh_token"] == first["refresh_token"] {
		t.Fatalf("refresh: %d %v", code, second)
	}
	// The spent token comes back: someone kept a copy. The grant ends for everyone.
	code, out := refresh(first["refresh_token"].(string))
	wantOAuthError(t, code, out, 400, "invalid_grant")
	code, out = refresh(second["refresh_token"].(string))
	wantOAuthError(t, code, out, 400, "invalid_grant")
	if f.live(second) {
		t.Error("a replayed refresh token left the grant live")
	}
	if code, out := f.token(url.Values{"grant_type": {"password"}, "client_id": {f.cimd}}); code != 400 || out["error"] != "unsupported_grant_type" {
		t.Errorf("password grant: %d %v", code, out)
	}
	if code, out := f.token(url.Values{"grant_type": {"refresh_token"}}); code != 401 || out["error"] != "invalid_client" {
		t.Errorf("no client_id: %d %v", code, out)
	}
}

func TestGrantsAreTheUsersOwn(t *testing.T) {
	f := newFixture(t)
	_, tokens := f.exchange(f.cimd, f.codeFor(f.cimd), testVerifier, testRedirect)
	alice, bob := f.session(f.alice, f.tenant, ""), f.session(f.bob, f.other, "")

	code, out, _ := f.call("GET", "/api/v1/oauth/grants", alice, "", "")
	rows, _ := out["data"].([]any)
	if code != 200 || len(rows) != 1 || rows[0].(map[string]any)["client_name"] != "Claude" {
		t.Fatalf("alice's grants: %d %v", code, out)
	}
	id := rows[0].(map[string]any)["id"].(string)
	if _, out, _ := f.call("GET", "/api/v1/oauth/grants", bob, "", ""); len(out["data"].([]any)) != 0 {
		t.Errorf("bob sees %v", out)
	}
	if code, _, _ := f.call("DELETE", "/api/v1/oauth/grants/"+id, bob, "", ""); code != 404 {
		t.Errorf("another tenant's revoke: %d, want 404", code)
	}
	if !f.live(tokens) {
		t.Fatal("grant revoked by another tenant")
	}
	if code, _, _ := f.call("DELETE", "/api/v1/oauth/grants/"+id, alice, "", ""); code != 204 {
		t.Fatalf("revoke: %d", code)
	}
	if f.live(tokens) {
		t.Error("revoked grant still live")
	}
	code, out = f.token(url.Values{"grant_type": {"refresh_token"}, "client_id": {f.cimd}, "refresh_token": {tokens["refresh_token"].(string)}})
	wantOAuthError(t, code, out, 400, "invalid_grant")
}

func TestDisabledUserLosesAccess(t *testing.T) {
	f := newFixture(t)
	_, tokens := f.exchange(f.cimd, f.codeFor(f.cimd), testVerifier, testRedirect)
	if _, err := f.db.Exec(context.Background(), `UPDATE users SET deleted_at = now() WHERE id = $1`, f.alice); err != nil {
		t.Fatal(err)
	}
	code, out := f.token(url.Values{"grant_type": {"refresh_token"}, "client_id": {f.cimd}, "refresh_token": {tokens["refresh_token"].(string)}})
	wantOAuthError(t, code, out, 400, "invalid_grant")
}

func TestConfig(t *testing.T) {
	for _, bad := range []types.Config{
		{MCPOAuthIssuer: "http://erp.example.com"},
		{MCPOAuthIssuer: "https://erp.example.com/app"},
		{MCPOAuthIssuer: "erp.example.com"},
		{MCPOAuthTrustedHosts: []string{"https://claude.ai"}},
		{MCPOAuthTrustedHosts: []string{"*.claude.ai"}},
	} {
		if ValidateConfig(&bad) == nil {
			t.Errorf("accepted %+v", bad)
		}
	}
	for _, good := range []types.Config{{MCPOAuthIssuer: "https://erp.example.com/"}, {MCPOAuthIssuer: "http://localhost:3000"}, {}} {
		if err := ValidateConfig(&good); err != nil {
			t.Errorf("refused %+v: %v", good, err)
		}
	}
	if _, on := FromConfig(&types.Config{MCPOAuthIssuer: "https://erp.example.com"}); on {
		t.Error("OAuth on while MCP is disabled")
	}
	s, on := FromConfig(&types.Config{MCPEnabled: true, MCPOAuthIssuer: "https://erp.example.com/"})
	if !on || s.Resource() != "https://erp.example.com/api/v1/mcp" || !s.TrustedHosts["claude.ai"] || !s.TrustedHosts["chatgpt.com"] {
		t.Errorf("settings %+v", s)
	}
}

// TestLoopbackClients: Claude Code (and Claude Desktop's mcp-remote) receive the code on
// http://localhost:<port>/callback, a port picked per sign-in (RFC 8252 §7.3).
func TestLoopbackClients(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	base := strings.TrimSuffix(f.cimd, "/client.json")
	id := base + "/claude-code.json"
	*f.doc = fmt.Sprintf(`{"client_id":%q,"client_name":"Claude Code","redirect_uris":["http://localhost/callback","http://127.0.0.1/callback"],"token_endpoint_auth_method":"none"}`, id)
	if _, err := f.h.ResolveClient(ctx, id); err != nil {
		t.Fatalf("Claude Code document refused: %v", err)
	}
	alice := f.session(f.alice, f.tenant, "")
	const redirect = "http://localhost:54321/callback"

	code, out := f.approve(alice, authParams(id, map[string]string{"redirect_uri": redirect}), true)
	to, _ := out["redirect_to"].(string)
	if code != 200 || out["ok"] != true || !strings.HasPrefix(to, redirect+"?") {
		t.Fatalf("loopback approve: %d %v", code, out)
	}
	u, _ := url.Parse(to)
	if code, out := f.exchange(id, u.Query().Get("code"), testVerifier, redirect); code != 200 || out["access_token"] == nil {
		t.Fatalf("loopback exchange: %d %v", code, out)
	}

	for name, uri := range map[string]string{
		"another path":          "http://localhost:54321/other",
		"a non-loopback http":   "http://evil.example:54321/callback",
		"a lookalike host":      "http://localhost.evil.example/callback",
		"https on the loopback": "https://localhost:54321/callback",
	} {
		if _, out := f.approve(alice, authParams(id, map[string]string{"redirect_uri": uri}), true); out["ok"] != false || out["redirect_to"] != nil {
			t.Errorf("%s accepted: %v", name, out)
		}
	}

	// mcp-remote registers itself with its loopback callback.
	code, reg, _ := f.call("POST", "/api/v1/oauth/register", "", "application/json",
		`{"redirect_uris":["http://localhost:3334/oauth/callback"],"client_name":"MCP CLI Proxy"}`)
	if code != 201 {
		t.Fatalf("loopback registration: %d %v", code, reg)
	}
	f.registeredClients = append(f.registeredClients, reg["client_id"].(string))
	if code, out, _ := f.call("POST", "/api/v1/oauth/register", "", "application/json",
		`{"redirect_uris":["http://evil.example/cb"]}`); code != 400 || out["error"] != "invalid_redirect_uri" {
		t.Errorf("plain http registration: %d %v", code, out)
	}
}
