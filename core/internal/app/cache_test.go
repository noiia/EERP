package app

import (
	"context"
	"os"
	"testing"

	"core/internal/types"
)

// Redis is optional (ADR-022): an unset or unreachable redis_url must boot
// uncached, never fail.
func TestOpenQueryCache(t *testing.T) {
	ctx := context.Background()
	if qc := openQueryCache(ctx, &types.Config{}); qc != nil {
		t.Fatal("unset redis_url must disable the cache")
	}
	if qc := openQueryCache(ctx, &types.Config{RedisURL: "redis://127.0.0.1:1/0"}); qc != nil {
		t.Fatal("unreachable Redis must disable the cache, not fail")
	}
	url := os.Getenv("REDIS_URL")
	if url == "" {
		t.Skip("REDIS_URL not set — skipping the reachable case")
	}
	qc := openQueryCache(ctx, &types.Config{RedisURL: url})
	if qc == nil {
		t.Fatal("reachable Redis must enable the cache")
	}
	qc.OnError(context.DeadlineExceeded) // rate-limited logger must not panic
	_ = qc.Close()
}
