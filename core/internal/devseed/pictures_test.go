package devseed_test

import (
	"bytes"
	"context"
	"image/png"
	"io"
	"strings"
	"sync"
	"testing"

	"core/internal/devseed"
	"core/internal/pictures"
	"core/internal/testdb"

	_ "core/modules/pictures"

	"github.com/google/uuid"
)

type memStore struct {
	mu   sync.Mutex
	objs map[string][]byte
}

func (m *memStore) Put(_ context.Context, key, _ string, _ int64, body io.Reader) error {
	b, err := io.ReadAll(body)
	m.mu.Lock()
	defer m.mu.Unlock()
	m.objs[key] = b
	return err
}

// TestSeedPictures: with a store, every picture field of the seeded groups gets
// a shared sample (valid PNGs under the tenant's _samples dir) and its flag.
func TestSeedPictures(t *testing.T) {
	app := testdb.Open(t)
	testdb.MigrateModules(t, app, "auth", "company", "settings", "graphfield", "contact", "crm", "warehouse", "sale", "propertymanagement", "event", "pictures")
	ctx := context.Background()
	tenant := uuid.New()
	t.Cleanup(func() {
		for _, table := range append([]string{"picture", "property_management_photo"}, seededTables...) {
			_, _ = app.DB.Exec(ctx, "DELETE FROM "+table+" WHERE tenant_id = $1", tenant)
		}
	})
	if _, err := app.DB.Exec(ctx, "INSERT INTO company (tenant_id, name, currency, is_default) VALUES ($1, 'Home', 'EUR', true)", tenant); err != nil {
		t.Fatal(err)
	}
	store := &memStore{objs: map[string][]byte{}}
	const n = 200
	if _, err := devseed.Seed(ctx, app.DB, store, tenant, n, []string{"crm", "property"}); err != nil {
		t.Fatal(err)
	}

	if len(store.objs) == 0 {
		t.Fatal("no sample uploaded")
	}
	for key, data := range store.objs {
		if !pictures.IsSampleKey(key) || !strings.HasPrefix(key, tenant.String()+"/") {
			t.Errorf("sample key %q outside the tenant's sample dir", key)
		}
		if _, err := png.Decode(bytes.NewReader(data)); err != nil {
			t.Errorf("%s: not a PNG: %v", key, err)
		}
	}
	count := func(q string) int {
		t.Helper()
		var c int
		if err := app.DB.QueryRow(ctx, q, tenant).Scan(&c); err != nil {
			t.Fatal(err)
		}
		return c
	}
	for field, want := range map[string]int{"picture": n, "signature": n} {
		if got := count(`SELECT count(*) FROM picture WHERE tenant_id = $1 AND table_name = 'crm' AND field = '` + field + `'`); got != want {
			t.Errorf("crm.%s pictures = %d, want %d", field, got, want)
		}
	}
	if got := count(`SELECT count(*) FROM crm WHERE tenant_id = $1 AND (picture IS NOT TRUE OR signature IS NOT TRUE)`); got != 0 {
		t.Errorf("%d crm rows without their picture flags", got)
	}
	if got, want := count(`SELECT count(*) FROM picture WHERE tenant_id = $1 AND table_name = 'property_management_photo'`), 3*count(`SELECT count(*) FROM property_management WHERE tenant_id = $1`); got != want || got == 0 {
		t.Errorf("property photos with a picture = %d, want %d", got, want)
	}
	if got := count(`SELECT count(*) FROM picture WHERE tenant_id = $1 AND table_name IN ('product', 'invoice', 'event')`); got != 0 {
		t.Errorf("%d pictures on groups not seeded", got)
	}
}
