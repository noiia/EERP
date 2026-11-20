// Package mcpoauth lets OAuth MCP clients (claude.ai, ChatGPT) connect to
// EERP's MCP endpoint on behalf of a staff user (ADR-043).
//
// EERP is its own authorization server: the user signs in with any ERP method
// (password, LDAP, OIDC) and approves the client on a consent page; the client
// gets an access token with the "mcp" audience, accepted only by /api/v1/mcp,
// and a rotating refresh token tied to a revocable grant. A client identifies
// itself by a Client ID Metadata Document (CIMD, an https client_id URL) or by
// dynamic client registration (DCR, RFC 7591); either way its metadata URL and
// redirect URIs must be on a host the operator trusts.
package mcpoauth

import (
	"fmt"
	"net/url"
	"strings"

	"core/internal/types"
)

// DefaultTrustedHosts is used when mcp_oauth_trusted_hosts is not set: the hosts
// claude.ai and ChatGPT publish their client metadata and callbacks on.
var DefaultTrustedHosts = []string{"claude.ai", "chatgpt.com"}

// MCPPath is the protected resource. Kept here (not imported from mcpbridge) so
// the bridge can depend on this package's checker without a cycle.
const MCPPath = "/api/v1/mcp"

// Settings is the resolved OAuth configuration.
type Settings struct {
	// Issuer is the public origin, e.g. https://erp.example.com (no trailing slash).
	Issuer       string
	TrustedHosts map[string]bool
}

// Resource is the MCP endpoint's public URL: the token audience a client asks for.
func (s Settings) Resource() string { return s.Issuer + MCPPath }

// ResourceMetadataURL is where a client reads which server issues tokens for MCP.
func (s Settings) ResourceMetadataURL() string {
	return s.Issuer + "/.well-known/oauth-protected-resource" + MCPPath
}

// FromConfig returns the settings and whether OAuth is on (MCP enabled and an issuer set).
func FromConfig(c *types.Config) (Settings, bool) {
	if !c.MCPEnabled || c.MCPOAuthIssuer == "" {
		return Settings{}, false
	}
	hosts := c.MCPOAuthTrustedHosts
	if hosts == nil {
		hosts = DefaultTrustedHosts
	}
	s := Settings{Issuer: strings.TrimSuffix(c.MCPOAuthIssuer, "/"), TrustedHosts: map[string]bool{}}
	for _, h := range hosts {
		s.TrustedHosts[strings.ToLower(h)] = true
	}
	return s, true
}

// ValidateConfig refuses an issuer that is not a bare https origin (http only on
// localhost, for development) and a trusted host that is not a plain host name.
func ValidateConfig(c *types.Config) error {
	if c.MCPOAuthIssuer != "" {
		u, err := url.Parse(strings.TrimSuffix(c.MCPOAuthIssuer, "/"))
		local := err == nil && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1")
		secure := err == nil && (u.Scheme == "https" || (u.Scheme == "http" && local))
		if !secure || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
			return fmt.Errorf("mcp_oauth_issuer: expected a public https origin such as https://erp.example.com, got %q", c.MCPOAuthIssuer)
		}
	}
	for _, h := range c.MCPOAuthTrustedHosts {
		if h == "" || strings.ContainsAny(h, "/:*@ ") {
			return fmt.Errorf("mcp_oauth_trusted_hosts: expected a host name such as claude.ai, got %q", h)
		}
	}
	return nil
}
