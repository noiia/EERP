// Package mcpbridge exposes EERP's authenticated business API through the official
// MCP SDK. All data operations re-enter the HTTP router, including its middleware
// and module-specific overrides; this package never reads or writes SQL.
package mcpbridge

import (
	"fmt"
	"net/url"
	"strings"

	"core/internal/types"
)

// ValidateConfig runs before opening the database, even when MCP is disabled,
// so a misspelled origin never silently broadens the trust boundary.
func ValidateConfig(c *types.Config) error {
	for _, origin := range c.MCPAllowedOrigins {
		u, err := url.Parse(origin)
		if err != nil || u.Host == "" || u.User != nil || (u.Scheme != "https" && u.Scheme != "http") ||
			u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.Opaque != "" || u.Hostname() == "" || strings.Contains(u.Host, "*") || origin != u.Scheme+"://"+u.Host {
			return fmt.Errorf("mcp_allowed_origins: expected an exact HTTP(S) origin, got %q", origin)
		}
	}
	if c.MCPRateLimitPerMinute < 0 {
		return fmt.Errorf("mcp_rate_limit_per_minute must be non-negative")
	}
	return nil
}
