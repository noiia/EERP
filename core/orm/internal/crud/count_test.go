package crud_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"core/orm/access"
	"core/orm/internal/crud"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// countingExec answers the bounded count with count and the EXPLAIN with a
// plan estimating estimate rows; everything else behaves like captureExec.
type countingExec struct {
	captureExec
	count    int64
	estimate float64
}

func (e *countingExec) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	e.record(sql, args)
	return funcRow(func(dest ...any) error {
		switch {
		case strings.HasPrefix(sql, "EXPLAIN"):
			plan, _ := json.Marshal([]map[string]any{{"Plan": map[string]any{"Plan Rows": e.estimate}}})
			*dest[0].(*[]byte) = plan
		case strings.Contains(sql, "AS bounded"):
			*dest[0].(*int64) = e.count
		}
		return nil
	})
}

type funcRow func(dest ...any) error

func (f funcRow) Scan(dest ...any) error { return f(dest...) }

func TestRepository_FindAll_BoundedTotal(t *testing.T) {
	ctx := access.WithTenant(context.Background(), uuid.New())
	for _, tc := range []struct {
		name     string
		count    int64
		estimate float64
		want     crud.Total
		explain  bool
	}{
		{"exact under the limit, no EXPLAIN", 4_321, 0, crud.Total{Rows: 4_321}, false},
		{"estimated past the limit", crud.ExactCountLimit + 1, 100_048, crud.Total{Rows: 100_048, Estimated: true}, true},
		{"estimate below the bound is raised to it", crud.ExactCountLimit + 1, 12, crud.Total{Rows: crud.ExactCountLimit + 1, Estimated: true}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ex := &countingExec{count: tc.count, estimate: tc.estimate}
			repo := crud.NewRepository(ex, tenantMeta(t))
			_, total, err := repo.FindAll(ctx, crud.ListFilter{Page: 1, PageSize: 20, Matches: map[string]string{"label": "ab"}})
			if err != nil {
				t.Fatalf("FindAll: %v", err)
			}
			if total != tc.want {
				t.Errorf("total = %+v, want %+v", total, tc.want)
			}
			countSQL, _ := ex.find(t, "AS bounded")
			if !strings.Contains(countSQL, "LIMIT 10001") || !strings.Contains(countSQL, "tenant_id =") || !strings.Contains(countSQL, "ILIKE") {
				t.Errorf("bounded count must keep every filter and cap at 10001: %s", countSQL)
			}
			explained := false
			for _, q := range ex.queries {
				explained = explained || strings.HasPrefix(q, "EXPLAIN")
			}
			if explained != tc.explain {
				t.Errorf("EXPLAIN issued = %v, want %v", explained, tc.explain)
			}
		})
	}
}

func TestPaginatedResponse_TotalEstimatedOmittedWhenExact(t *testing.T) {
	for _, tc := range []struct {
		name string
		resp crud.PaginatedResponse
		want string
	}{
		{"exact", crud.PaginatedResponse{Total: 3}, `"total":3,`},
		{"estimated", crud.PaginatedResponse{Total: 100048, TotalEstimated: true}, `"total_estimated":true`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b, _ := json.Marshal(tc.resp)
			if !strings.Contains(string(b), tc.want) {
				t.Errorf("%s does not contain %s", b, tc.want)
			}
			if !tc.resp.TotalEstimated && strings.Contains(string(b), "total_estimated") {
				t.Errorf("exact total must omit total_estimated: %s", b)
			}
		})
	}
}

func TestPageEntry_PreUpgradeCacheEntryDecodesAsExact(t *testing.T) {
	got, err := crud.DecodePageEntry([]byte(`{"rows":[],"total":57}`))
	if err != nil {
		t.Fatal(err)
	}
	if got != (crud.Total{Rows: 57}) {
		t.Errorf("got %+v, want an exact 57", got)
	}
}
