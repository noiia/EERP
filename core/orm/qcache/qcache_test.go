package qcache

import (
	"context"
	"encoding/json"
	"os"
	"testing"

	"github.com/google/uuid"
)

func TestWriteTarget(t *testing.T) {
	for _, tc := range []struct {
		sql   string
		table string
		write bool
	}{
		{"SELECT * FROM crm WHERE id = $1", "", false},
		{"  select 1", "", false},
		{"BEGIN", "", false},
		{"INSERT INTO crm (name) VALUES ($1)", "crm", true},
		{`INSERT INTO "public"."crm"(name) VALUES ($1) RETURNING *`, "crm", true},
		{"UPDATE crm SET name = $1", "crm", true},
		{"UPDATE ONLY crm SET name = $1", "crm", true},
		{"DELETE FROM sale_line WHERE id = $1", "sale_line", true},
		{"WITH x AS (DELETE FROM crm RETURNING id) SELECT count(*) FROM x", "", true},
		{"WITH x AS (SELECT 1) SELECT * FROM x", "", false},
		{"ALTER TABLE crm ADD COLUMN x text", "", true},
		{"TRUNCATE crm", "", true},
		{"", "", false},
	} {
		table, write := WriteTarget(tc.sql)
		if table != tc.table || write != tc.write {
			t.Errorf("WriteTarget(%q) = (%q, %v), want (%q, %v)", tc.sql, table, write, tc.table, tc.write)
		}
	}
}

func TestNilCacheIsANoop(t *testing.T) {
	var c *Cache
	var dst any
	if key, hit := c.Lookup(context.Background(), "db", "t", "SELECT 1", nil, &dst); key != "" || hit {
		t.Fatal("nil cache must miss with no key")
	}
	c.Store(context.Background(), "k", 1)
	c.Invalidate(context.Background(), "db")
	if err := c.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestNewFailsOnUnreachableRedis(t *testing.T) {
	if _, err := New(context.Background(), "redis://127.0.0.1:1/0", 0); err == nil {
		t.Fatal("expected an error for an unreachable Redis")
	}
	if _, err := New(context.Background(), "not a url", 0); err == nil {
		t.Fatal("expected an error for a malformed URL")
	}
}

// openTestCache needs a real Redis (REDIS_URL, e.g. redis://127.0.0.1:6379/0 —
// compose.yml's redis service); skipped without one, like testdb without TEST_DSN.
func openTestCache(t *testing.T) *Cache {
	t.Helper()
	url := os.Getenv("REDIS_URL")
	if url == "" {
		t.Skip("REDIS_URL not set — skipping Redis-backed test")
	}
	c, err := New(context.Background(), url, 0)
	if err != nil {
		t.Fatalf("connect redis: %v", err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func TestLookupStoreInvalidate(t *testing.T) {
	c := openTestCache(t)
	ctx := context.Background()
	db := "qcache_test_" + uuid.NewString() // fresh namespace per run
	args := []any{uuid.New(), 12.5}

	var got []map[string]any
	key, hit := c.Lookup(ctx, db, "items", "SELECT 1", args, &got)
	if hit || key == "" {
		t.Fatalf("first lookup: hit=%v key=%q, want a miss with a key", hit, key)
	}
	c.Store(ctx, key, []map[string]any{{"amount": json.Number("1234567890.123456789")}})

	if _, hit = c.Lookup(ctx, db, "items", "SELECT 1", args, &got); !hit {
		t.Fatal("expected a hit after Store")
	}
	if n := got[0]["amount"]; n != json.Number("1234567890.123456789") {
		t.Fatalf("numeric precision lost: %v (%T)", n, n)
	}

	// Other tables and other databases are untouched by an invalidation.
	c.Invalidate(ctx, db, "other")
	if _, hit = c.Lookup(ctx, db, "items", "SELECT 1", args, &got); !hit {
		t.Fatal("invalidating another table must not evict this entry")
	}
	c.Invalidate(ctx, db, "items")
	if _, hit = c.Lookup(ctx, db, "items", "SELECT 1", args, &got); hit {
		t.Fatal("expected a miss after invalidating the table")
	}

	key, _ = c.Lookup(ctx, db, "items", "SELECT 1", args, &got)
	c.Store(ctx, key, []int{1})
	c.Invalidate(ctx, db) // whole database
	if _, hit = c.Lookup(ctx, db, "items", "SELECT 1", args, &got); hit {
		t.Fatal("expected a miss after a database-wide invalidation")
	}
}
