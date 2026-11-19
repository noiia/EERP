package crud_test

import (
	"context"
	"strings"
	"testing"

	"core/orm/internal/crud"
	"core/orm/internal/registry"
)

// Rows at equal distance (all unlocated rows: NULL) must keep a stable order
// across pages, so near[] breaks ties on the primary key.
func TestRepository_NearOrdersByDistanceThenPK(t *testing.T) {
	_ = registry.Register[cachePlace]()
	meta, _ := registry.Get("cache_place")
	ex := &captureExec{}
	f := crud.ListFilter{Page: 2, PageSize: 3, Geo: crud.GeoFilter{Near: map[string]string{"spot": "2.35,48.85"}}}
	if _, _, err := crud.NewRepository(ex, meta).FindAll(context.Background(), f); err != nil {
		t.Fatal(err)
	}
	sql, _ := ex.find(t, "ORDER BY")
	order := sql[strings.Index(sql, "ORDER BY"):]
	if !strings.Contains(order, "<->") || !strings.Contains(order, ", id") {
		t.Errorf("near ORDER BY = %q, want distance then id", order)
	}
}
