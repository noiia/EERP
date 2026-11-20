package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"core/internal/types"
)

func TestApp_MCPMount(t *testing.T) {
	// MCPAllowWrites pinned: the local config may enable it, and this test asserts the read-only tool set.
	c := buildAppWith(t, func(cfg *types.Config) { cfg.MCPEnabled, cfg.MCPAllowWrites = true, false })
	code, body := c.do("POST", "/api/v1/mcp", map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
	// Missing MCP Accept is rejected by the SDK, demonstrating that the route
	// reached the MCP handler through the fully built application's JWT layer.
	if code != 400 {
		t.Fatalf("MCP content negotiation: %d %s", code, body)
	}
	req := httptest.NewRequest("POST", "/api/v1/mcp", bytes.NewBufferString(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("Authorization", "Bearer "+c.token)
	rec := httptest.NewRecorder()
	c.h.ServeHTTP(rec, req)
	var rpc map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &rpc); err != nil || rec.Code != 200 || rpc["result"] == nil ||
		!strings.Contains(rec.Body.String(), "eerp_get_project") || strings.Contains(rec.Body.String(), "eerp_write_operation") {
		t.Fatalf("MCP tools: %d %s (%v)", rec.Code, rec.Body.String(), err)
	}
	c.token = ""
	if code, _ := c.do("POST", "/api/v1/mcp", map[string]any{}); code != 401 {
		t.Fatalf("MCP authentication: %d", code)
	}
}

// TestApp_MCPOAuth runs an OAuth client through the real app (ADR-043): a
// dynamically registered client, the consent call as the signed-in admin, the
// code exchange, then MCP calls with the "mcp" audience token — including one
// that re-enters the API, which must accept the token there too.
func TestApp_MCPOAuth(t *testing.T) {
	const issuer, redirect = "https://erp.test", "https://claude.ai/api/mcp/auth_callback"
	const verifier = "verifier-0123456789-0123456789-0123456789-abcdef"
	c := buildAppWith(t, func(cfg *types.Config) {
		cfg.MCPEnabled, cfg.MCPAllowWrites, cfg.MCPOAuthIssuer = true, false, issuer
	})
	t.Cleanup(func() {
		_, _ = c.a.db.DB.Exec(context.Background(), `DELETE FROM oauth_grant WHERE client_name = 'App test'`)
		_, _ = c.a.db.DB.Exec(context.Background(), `DELETE FROM oauth_client WHERE name = 'App test'`)
	})
	mcpCall := func(token, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("POST", "/api/v1/mcp", bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		rec := httptest.NewRecorder()
		c.h.ServeHTTP(rec, req)
		return rec
	}

	// No token: the 401 tells the client where to sign in.
	if rec := mcpCall("", `{}`); rec.Code != 401 || rec.Header().Get("WWW-Authenticate") !=
		`Bearer resource_metadata="`+issuer+`/.well-known/oauth-protected-resource/api/v1/mcp"` {
		t.Fatalf("anonymous MCP: %d %q", rec.Code, rec.Header().Get("WWW-Authenticate"))
	}
	if code, body := c.do("GET", "/.well-known/oauth-authorization-server", nil); code != 200 || !strings.Contains(string(body), `"client_id_metadata_document_supported":true`) {
		t.Fatalf("metadata: %d %s", code, body)
	}

	code, body := c.do("POST", "/api/v1/oauth/register", map[string]any{"redirect_uris": []string{redirect}, "client_name": "App test"})
	if code != 201 {
		t.Fatalf("register: %d %s", code, body)
	}
	clientID := decode(t, body)["client_id"].(string)
	sum := sha256.Sum256([]byte(verifier))
	code, body = c.do("POST", "/api/v1/oauth/authorize", map[string]any{"approve": true, "params": map[string]string{
		"client_id": clientID, "redirect_uri": redirect, "response_type": "code", "state": "s",
		"code_challenge": base64.RawURLEncoding.EncodeToString(sum[:]), "code_challenge_method": "S256"}})
	if code != 200 {
		t.Fatalf("authorize: %d %s", code, body)
	}
	to, _ := url.Parse(decode(t, body)["redirect_to"].(string))
	form := url.Values{"grant_type": {"authorization_code"}, "client_id": {clientID}, "code": {to.Query().Get("code")},
		"code_verifier": {verifier}, "redirect_uri": {redirect}}
	req := httptest.NewRequest("POST", "/api/v1/oauth/token", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := httptest.NewRecorder()
	c.h.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("token: %d %s", rec.Code, rec.Body)
	}
	mcpToken := decode(t, rec.Body.Bytes())["access_token"].(string)

	// The MCP token reads business data through MCP (eerp_read_operation re-enters the API)...
	rec = mcpCall(mcpToken, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"eerp_read_operation","arguments":{"operation":"GET /api/v1/notifications"}}}`)
	if rec.Code != 200 || strings.Contains(rec.Body.String(), `"isError":true`) || !strings.Contains(rec.Body.String(), `\"unread\"`) {
		t.Fatalf("MCP read with the OAuth token: %d %s", rec.Code, rec.Body)
	}
	// ...but is no ERP session.
	erp := c.token
	c.token = mcpToken
	if code, _ := c.do("GET", "/api/v1/me/preferences", nil); code != 403 {
		t.Errorf("MCP token on an ERP route: %d, want 403", code)
	}
	c.token = erp

	// Revoking the app ends the token at once.
	code, body = c.do("GET", "/api/v1/oauth/grants", nil)
	grants, _ := decode(t, body)["data"].([]any)
	if code != 200 || len(grants) == 0 {
		t.Fatalf("grants: %d %s", code, body)
	}
	for _, g := range grants {
		if g.(map[string]any)["client_name"] == "App test" {
			if code, _ := c.do("DELETE", "/api/v1/oauth/grants/"+g.(map[string]any)["id"].(string), nil); code != 204 {
				t.Fatalf("revoke: %d", code)
			}
		}
	}
	if rec := mcpCall(mcpToken, `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`); rec.Code != 401 || rec.Header().Get("WWW-Authenticate") == "" {
		t.Errorf("revoked token: %d %q", rec.Code, rec.Header().Get("WWW-Authenticate"))
	}
}
