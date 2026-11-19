package crud_test

import (
	"context"
	"testing"
	"time"

	"core/orm/access"
	"core/orm/geo"
	"core/orm/internal/crud"
	"core/orm/internal/registry"

	"github.com/google/uuid"
)

// spyCache counts the read cache's traffic; it never hits.
type spyCache struct{ lookups, stores int }

func (c *spyCache) Lookup(context.Context, string, string, string, []any, any) (string, bool) {
	c.lookups++
	return "key", false
}

func (c *spyCache) Store(context.Context, string, any) { c.stores++ }

type cachePlace struct {
	ID        uuid.UUID  `db:"id,pk"`
	CreatedAt time.Time  `db:"created_at"`
	UpdatedAt time.Time  `db:"updated_at"`
	DeletedAt *time.Time `db:"deleted_at,softdelete"`
	Label     string     `db:"label"`
	Spot      *geo.Point `db:"spot"`
}

type cacheZone struct {
	ID        uuid.UUID  `db:"id,pk"`
	CreatedAt time.Time  `db:"created_at"`
	UpdatedAt time.Time  `db:"updated_at"`
	DeletedAt *time.Time `db:"deleted_at,softdelete"`
	Area      *geo.Shape `db:"area"`
}

// An inside[] list depends on another table's zone, whose writes don't bump
// this table's cache generation: it must neither read nor fill the cache,
// while the same reads without inside[] do both.
func TestRepository_InsideFilterBypassesReadCache(t *testing.T) {
	if err := registry.Register[cachePlace](); err != nil {
		t.Fatal(err)
	}
	if err := registry.Register[cacheZone](); err != nil {
		t.Fatal(err)
	}
	meta, _ := registry.Get("cache_place")
	ctx := access.WithReadCheck(context.Background(), func(string) bool { return true })
	inside := crud.ListFilter{Page: 1, PageSize: 20, Geo: crud.GeoFilter{
		Inside: map[string]string{"spot": "cache_zone:" + uuid.NewString() + ":area"},
	}}
	plain := crud.ListFilter{Page: 1, PageSize: 20}

	reads := map[string]func(*crud.Repository, crud.ListFilter) error{
		"list": func(r *crud.Repository, f crud.ListFilter) error {
			_, _, err := r.FindAll(ctx, f)
			return err
		},
		"distinct": func(r *crud.Repository, f crud.ListFilter) error {
			_, err := r.DistinctValues(ctx, "label", f)
			return err
		},
		"aggregate": func(r *crud.Repository, f crud.ListFilter) error {
			_, err := r.Aggregate(ctx, crud.AggregateRequest{Kind: "count"}, f)
			return err
		},
	}
	for name, read := range reads {
		t.Run(name, func(t *testing.T) {
			for _, tc := range []struct {
				name   string
				f      crud.ListFilter
				cached bool
			}{{"plain", plain, true}, {"inside", inside, false}} {
				spy := &spyCache{}
				restore := crud.StubCache(spy)
				err := read(crud.NewRepository(&captureExec{}, meta), tc.f)
				restore()
				if err != nil {
					t.Fatalf("%s: %v", tc.name, err)
				}
				used := spy.lookups > 0 && spy.stores > 0
				none := spy.lookups == 0 && spy.stores == 0
				if tc.cached && !used || !tc.cached && !none {
					t.Errorf("%s: lookups=%d stores=%d, want cached=%v", tc.name, spy.lookups, spy.stores, tc.cached)
				}
			}
		})
	}
}
