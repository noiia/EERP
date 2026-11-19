package query_test

import (
	"context"
	"testing"

	"core/orm/query"
)

// funcRow is a pgx.Row whose Scan is the test's own function.
type funcRow func(dest ...any) error

func (f funcRow) Scan(dest ...any) error { return f(dest...) }

// scanCount is a row yielding one int64 count.
func scanCount(n int64) funcRow {
	return func(dest ...any) error { *dest[0].(*int64) = n; return nil }
}

func TestSelect_CountUpTo(t *testing.T) {
	t.Parallel()
	meta := mustMeta[order](t)
	base := query.Select[order](meta).
		Where(query.NewCondition("status = $1", "open")).
		OrderBy("created_at DESC").Limit(50).Offset(100)

	for _, tc := range []struct {
		name       string
		got        int64
		wantN      int64
		wantCapped bool
	}{
		{"under the limit is exact", 7, 7, false},
		{"exactly the limit is exact", 10, 10, false},
		{"one past the limit is capped", 11, 11, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ex := &mockExecutor{row: scanCount(tc.got)}
			n, capped, err := base.CountUpTo(context.Background(), ex, 10)
			if err != nil {
				t.Fatalf("CountUpTo: %v", err)
			}
			if n != tc.wantN || capped != tc.wantCapped {
				t.Errorf("got (%d, %v), want (%d, %v)", n, capped, tc.wantN, tc.wantCapped)
			}
			want := "SELECT COUNT(*) FROM (SELECT 1 FROM order WHERE status = $1 LIMIT 11) AS bounded"
			if ex.lastSQL != want {
				t.Errorf("SQL\n got: %s\nwant: %s", ex.lastSQL, want)
			}
			if len(ex.lastArgs) != 1 || ex.lastArgs[0] != "open" {
				t.Errorf("args = %v", ex.lastArgs)
			}
		})
	}
}

func TestSelect_EstimateRows(t *testing.T) {
	t.Parallel()
	meta := mustMeta[order](t)
	b := query.Select[order](meta).Where(query.NewCondition("status = $1", "open")).OrderBy("id").Limit(5)

	t.Run("reads Plan Rows from the JSON plan", func(t *testing.T) {
		ex := &mockExecutor{row: funcRow(func(dest ...any) error {
			*dest[0].(*[]byte) = []byte(`[{"Plan":{"Node Type":"Seq Scan","Plan Rows":100048.4}}]`)
			return nil
		})}
		n, err := b.EstimateRows(context.Background(), ex)
		if err != nil {
			t.Fatalf("EstimateRows: %v", err)
		}
		if n != 100048 {
			t.Errorf("n = %d, want 100048", n)
		}
		if want := "EXPLAIN (FORMAT JSON) SELECT 1 FROM order WHERE status = $1"; ex.lastSQL != want {
			t.Errorf("SQL\n got: %s\nwant: %s", ex.lastSQL, want)
		}
	})

	t.Run("an unreadable plan is an error, not zero", func(t *testing.T) {
		ex := &mockExecutor{row: funcRow(func(dest ...any) error {
			*dest[0].(*[]byte) = []byte(`[]`)
			return nil
		})}
		if _, err := b.EstimateRows(context.Background(), ex); err == nil {
			t.Fatal("want an error for an empty plan")
		}
	})
}

func TestSelect_BoundedTotal(t *testing.T) {
	t.Parallel()
	meta := mustMeta[order](t)
	b := query.Select[order](meta).Where(query.NewCondition("status = $1", "open"))

	for _, tc := range []struct {
		name          string
		count         int64
		planRows      string
		wantN         int64
		wantEstimated bool
	}{
		{"under the limit is exact", 7, "999", 7, false},
		{"past the limit is the estimate", 11, "5000.4", 5000, true},
		{"estimate below the bound is raised to it", 11, "3", 11, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ex := &mockExecutor{row: funcRow(func(dest ...any) error {
				switch d := dest[0].(type) {
				case *int64:
					*d = tc.count
				case *[]byte:
					*d = []byte(`[{"Plan":{"Plan Rows":` + tc.planRows + `}}]`)
				}
				return nil
			})}
			n, estimated, err := b.BoundedTotal(context.Background(), ex, 10)
			if err != nil {
				t.Fatalf("BoundedTotal: %v", err)
			}
			if n != tc.wantN || estimated != tc.wantEstimated {
				t.Errorf("got (%d, %v), want (%d, %v)", n, estimated, tc.wantN, tc.wantEstimated)
			}
		})
	}
}
