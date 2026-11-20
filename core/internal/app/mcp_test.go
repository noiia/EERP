package app

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
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
