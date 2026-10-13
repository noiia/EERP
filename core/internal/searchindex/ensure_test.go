package searchindex_test

import (
	"context"
	"fmt"
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

func TestEnsure(t *testing.T) {
	db, table := setupProbe(t)
	ctx := context.Background()
	label := searchindex.IndexName(searchindex.Candidate{Table: table, Column: "label"})
	status := searchindex.IndexName(searchindex.Candidate{Table: table, Column: "status"})

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
		created, err := searchindex.Ensure(ctx, db)
		if err != nil {
			t.Fatalf("Ensure: %v", err)
		}
		if len(created) != 0 {
			t.Errorf("second pass created %v, want nothing", created)
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
