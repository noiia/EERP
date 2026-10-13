package searchindex_test

import (
	"context"
	"fmt"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"core/internal/searchindex"
	"core/internal/testdb"
	"core/orm"

	"github.com/google/uuid"
)

type probeRow struct {
	ID        uuid.UUID `db:"id,pk"`
	CreatedAt time.Time `db:"created_at"`
	UpdatedAt time.Time `db:"updated_at"`
	Label     string    `db:"label"`  // md5 per row: wide, high-cardinality → indexed
	Status    string    `db:"status"` // 3 values → enum-like, never indexed
}

// setupProbe creates a fresh, uniquely named 12 000-row table (above
// DefaultPolicy.MinTableRows) and drops only it at the end — the test may run
// against the live dev database.
func setupProbe(t *testing.T) (*orm.DB, string) {
	t.Helper()
	app := testdb.Open(t)
	table := fmt.Sprintf("si_probe_%d", time.Now().UnixNano())
	if err := orm.Register[probeRow](orm.WithTableName(table)); err != nil {
		t.Fatal(err)
	}
	testdb.Migrate(t, app, table)
	ctx := context.Background()
	t.Cleanup(func() { _, _ = app.DB.Exec(context.Background(), "DROP TABLE IF EXISTS "+table) })
	if _, err := app.DB.Exec(ctx, `INSERT INTO `+table+` (id, created_at, updated_at, label, status)
		SELECT gen_random_uuid(), now(), now(), md5(i::text), (ARRAY['open','won','lost'])[1 + i % 3]
		FROM generate_series(1, 12000) AS i`); err != nil {
		t.Fatal(err)
	}
	if _, err := app.DB.Exec(ctx, "ANALYZE "+table); err != nil {
		t.Fatal(err)
	}
	return app.DB, table
}

func indexValid(t *testing.T, db *orm.DB, name string) (exists, valid bool) {
	t.Helper()
	err := db.QueryRow(context.Background(),
		`SELECT i.indisvalid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
		 WHERE c.relname = $1 AND c.relnamespace = current_schema()::regnamespace`, name).Scan(&valid)
	return err == nil, valid
}

// indexIdentity is name's pg_class oid and row version.
func indexIdentity(t *testing.T, db *orm.DB, name string) string {
	t.Helper()
	var id string
	if err := db.QueryRow(context.Background(),
		`SELECT oid::text || '/' || xmin::text FROM pg_class
		 WHERE relname = $1 AND relnamespace = current_schema()::regnamespace`, name).Scan(&id); err != nil {
		t.Fatalf("identity of %s: %v", name, err)
	}
	return id
}

func TestEnsure(t *testing.T) {
	db, table := setupProbe(t)
	ctx := context.Background()
	label := searchindex.IndexName(searchindex.Candidate{Table: table, Column: "label"})
	status := searchindex.IndexName(searchindex.Candidate{Table: table, Column: "status"})

	t.Run("skips the pass while another holds the lock", func(t *testing.T) {
		// A pass blocked waiting on the lock would hold a snapshot the holder's
		// CREATE INDEX CONCURRENTLY waits for: an undetectable deadlock. So a
		// pass that finds the lock taken returns at once instead of waiting.
		holder, err := db.Pool().Acquire(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := holder.Exec(ctx, "SELECT pg_advisory_lock($1)", int64(7311990002)); err != nil {
			holder.Release()
			t.Fatal(err)
		}
		defer func() {
			_, _ = holder.Exec(context.Background(), "SELECT pg_advisory_unlock($1)", int64(7311990002))
			holder.Release()
		}()
		passCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		start := time.Now()
		created, err := searchindex.Ensure(passCtx, db)
		if err != nil {
			t.Fatalf("Ensure while locked: %v (after %s)", err, time.Since(start))
		}
		if took := time.Since(start); took > 2*time.Second {
			t.Errorf("Ensure waited %s for the lock, want an immediate skip", took)
		}
		if len(created) != 0 {
			t.Errorf("created %v while another pass holds the lock, want nothing", created)
		}
		if exists, _ := indexValid(t, db, label); exists {
			t.Errorf("%s built while another pass holds the lock", label)
		}
	})

	t.Run("indexes the compliant column only", func(t *testing.T) {
		created, err := searchindex.Ensure(ctx, db)
		if err != nil {
			t.Fatalf("Ensure: %v", err)
		}
		if !slices.Contains(created, label) {
			t.Errorf("created %v, want it to contain %s", created, label)
		}
		if exists, valid := indexValid(t, db, label); !exists || !valid {
			t.Errorf("%s exists=%v valid=%v", label, exists, valid)
		}
		if exists, _ := indexValid(t, db, status); exists {
			t.Errorf("enum-like status must not be indexed")
		}
	})

	t.Run("the list search SQL uses it", func(t *testing.T) {
		rows, err := db.Query(ctx, "EXPLAIN SELECT id FROM "+table+" WHERE label::text ILIKE '%' || $1 || '%'", "abcd")
		if err != nil {
			t.Fatal(err)
		}
		var plan strings.Builder
		for rows.Next() {
			var line string
			if err := rows.Scan(&line); err != nil {
				t.Fatal(err)
			}
			plan.WriteString(line + "\n")
		}
		rows.Close()
		if !strings.Contains(plan.String(), label) {
			t.Errorf("plan does not use %s:\n%s", label, plan.String())
		}
	})

	t.Run("a pass with nothing to do executes no DDL", func(t *testing.T) {
		// A rebuilt index would get a new pg_class row (oid and xmin change).
		before := indexIdentity(t, db, label)
		// Any db.Exec (CREATE EXTENSION IF NOT EXISTS included, which leaves
		// the catalog untouched) bumps the read cache's database generation,
		// so an entry cached before the pass must still be served after it.
		var cache *orm.QueryCache
		if url := os.Getenv("REDIS_URL"); url != "" {
			c, err := orm.NewQueryCache(ctx, url, 0)
			if err != nil {
				t.Fatalf("redis: %v", err)
			}
			cache = c
			db.SetQueryCache(cache)
			t.Cleanup(func() { db.SetQueryCache(nil); _ = cache.Close() })
		} else {
			t.Log("REDIS_URL not set: checking the index catalog only, not the cache generation")
		}
		var dst any
		key, _ := cache.Lookup(ctx, db.Name(), table, "SELECT probe", nil, &dst)
		cache.Store(ctx, key, 1)

		created, err := searchindex.Ensure(ctx, db)
		if err != nil {
			t.Fatalf("Ensure: %v", err)
		}
		if len(created) != 0 {
			t.Errorf("second pass created %v, want nothing", created)
		}
		if after := indexIdentity(t, db, label); after != before {
			t.Errorf("%s was rebuilt by an idle pass: %s -> %s", label, before, after)
		}
		if cache != nil {
			if _, hit := cache.Lookup(ctx, db.Name(), table, "SELECT probe", nil, &dst); !hit {
				t.Error("an idle pass invalidated the read cache: it executed DDL")
			}
		}
	})

	t.Run("rebuilds an invalid index", func(t *testing.T) {
		if _, err := db.Exec(ctx, "DROP INDEX "+label); err != nil {
			t.Fatal(err)
		}
		// A failed concurrent build leaves an INVALID index under the name:
		// the shape an interrupted build has.
		if _, err := db.Exec(ctx, "CREATE UNIQUE INDEX CONCURRENTLY "+label+" ON "+table+" (status)"); err == nil {
			t.Fatal("setup: the unique build over duplicates should fail")
		}
		if exists, valid := indexValid(t, db, label); !exists || valid {
			t.Fatalf("setup: want an invalid %s, got exists=%v valid=%v", label, exists, valid)
		}
		created, err := searchindex.Ensure(ctx, db)
		if err != nil {
			t.Fatalf("Ensure: %v", err)
		}
		if !slices.Contains(created, label) {
			t.Errorf("created %v, want the rebuilt %s", created, label)
		}
		if _, valid := indexValid(t, db, label); !valid {
			t.Errorf("%s still invalid", label)
		}
	})
}
