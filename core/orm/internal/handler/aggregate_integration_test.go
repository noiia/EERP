package handler_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"core/internal/testdb"
	"core/orm/access"
	"core/orm/internal/crud"
	"core/orm/internal/handler"
	"core/orm/internal/registry"
	"core/orm/model"
	ormserver "core/orm/server"

	"github.com/google/uuid"
)

type AggItem struct {
	model.BaseModel
	Status string     `db:"status"`
	Amount *float64   `db:"amount"`
	Cost   float64    `db:"cost"`
	Day    *time.Time `db:"day"`
}

// TestIntegration_Aggregate drives ?aggregate= end to end over a real table:
// buckets, groups, every aggregate kind, formulas (NULL/unknown → 0, x/0 → 0)
// and the 400 paths.
func TestIntegration_Aggregate(t *testing.T) {
	app := testdb.Open(t)
	_ = registry.Register[AggItem](registry.WithTableName("agg_items"))
	testdb.Migrate(t, app, "agg_items")
	meta, _ := registry.Get("agg_items")
	repo := crud.NewRepository(app.DB, meta)
	srv := ormserver.New(app, ormserver.Config{})
	srv.RegisterRoutes(map[string]*handler.GenericHandler{"h": handler.NewGenericHandlerFromSvc(crud.NewService(repo, meta), meta)}, nil)
	e := srv.Echo()

	tenant := uuid.New()
	ctx := context.Background()
	t.Cleanup(func() { _, _ = app.DB.Exec(ctx, "DELETE FROM agg_items WHERE tenant_id = $1", tenant) })
	for _, row := range []struct {
		status string
		amount any
		cost   float64
		day    string
	}{
		{"paid", 10.0, 2, "2026-01-05T10:00:00Z"},
		{"paid", 30.0, 0, "2026-01-20T10:00:00Z"},
		{"sent", 20.0, 4, "2026-02-03T10:00:00Z"},
		{"sent", nil, 5, "2026-02-04T10:00:00Z"},
		{"", 100.0, 1, "2026-02-04T10:00:00Z"},
	} {
		if _, err := app.DB.Exec(ctx, "INSERT INTO agg_items (tenant_id, status, amount, cost, day) VALUES ($1, $2, $3, $4, $5)",
			tenant, row.status, row.amount, row.cost, row.day); err != nil {
			t.Fatal(err)
		}
	}

	get := func(q url.Values) (int, []crud.AggregateRow) {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/agg_items?"+q.Encode(), nil)
		req = req.WithContext(access.WithTenant(req.Context(), tenant))
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, req)
		var body crud.AggregateResponse
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		return rec.Code, body.Groups
	}
	q := func(kv ...string) url.Values {
		v := url.Values{}
		for i := 0; i < len(kv); i += 2 {
			v.Set(kv[i], kv[i+1])
		}
		return v
	}

	t.Run("stat kinds over all rows", func(t *testing.T) {
		for _, tc := range []struct {
			kind string
			want float64
		}{{"sum", 160}, {"avg", 40}, {"mean", 40}, {"median", 25}, {"count", 4}} {
			code, got := get(q("aggregate", tc.kind, "value", "amount"))
			if code != 200 || len(got) != 1 || got[0].Value != tc.want {
				t.Errorf("%s: %d %+v, want %v", tc.kind, code, got, tc.want)
			}
		}
		if _, got := get(q("aggregate", "count")); got[0].Value != 5 {
			t.Errorf("count(*) = %v, want 5 rows", got[0].Value)
		}
	})

	t.Run("month buckets split by group, empty group skipped", func(t *testing.T) {
		_, got := get(q("aggregate", "sum", "value", "amount", "x", "day", "bucket", "month", "group", "status"))
		want := []crud.AggregateRow{
			{X: "2026-01", Group: "paid", Value: 40, Count: 2},
			{X: "2026-02", Group: "sent", Value: 20, Count: 1},
		}
		if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
			t.Fatalf("got %+v, want %+v", got, want)
		}
	})

	t.Run("pie: count is rows per group, value sums non-null", func(t *testing.T) {
		_, got := get(q("aggregate", "sum", "value", "amount", "group", "status"))
		want := []crud.AggregateRow{{Group: "paid", Value: 40, Count: 2}, {Group: "sent", Value: 20, Count: 2}}
		if len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
			t.Fatalf("got %+v, want %+v", got, want)
		}
	})

	t.Run("week buckets start on Monday", func(t *testing.T) {
		_, got := get(q("aggregate", "count", "x", "day", "bucket", "week", "filter[status]", "sent"))
		if len(got) != 1 || got[0].X != "2026-02-02" || got[0].Count != 2 {
			t.Fatalf("got %+v", got)
		}
	})

	t.Run("formula: NULL and unknown read 0, x/0 reads 0", func(t *testing.T) {
		// amount/cost per row: 10/2=5, 30/0→0, 20/4=5, NULL→0/5=0, 100/1=100; +nope(0)
		_, got := get(q("aggregate", "sum", "value", "(amount / cost) + nope * 3"))
		if len(got) != 1 || got[0].Value != 110 || got[0].Count != 5 {
			t.Fatalf("got %+v, want value 110 over 5 rows", got)
		}
		_, got = get(q("aggregate", "sum", "value", "-amount + 2 * -(cost)"))
		if got[0].Value != -160-24 {
			t.Fatalf("unary minus: got %v", got[0].Value)
		}
	})

	t.Run("bad requests", func(t *testing.T) {
		for _, v := range []url.Values{
			q("aggregate", "max", "value", "amount"),
			q("aggregate", "sum"),
			q("aggregate", "sum", "value", "nope"),
			q("aggregate", "count", "x", "status", "bucket", "month"),
			q("aggregate", "count", "x", "day", "bucket", "year"),
			q("aggregate", "count", "group", "nope"),
		} {
			if code, _ := get(v); code != http.StatusBadRequest {
				t.Errorf("%s: status %d, want 400", v.Encode(), code)
			}
		}
	})
}
