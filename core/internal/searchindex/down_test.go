package searchindex_test

import (
	"context"
	"testing"

	"core/internal/searchindex"
	"core/internal/testdb"
)

// A database that can't be reached: the pass fails without building anything.
func TestEnsure_DatabaseDown(t *testing.T) {
	created, err := searchindex.Ensure(context.Background(), testdb.Closed(t).DB)
	if err == nil {
		t.Fatal("want an error on a closed database")
	}
	if len(created) != 0 {
		t.Fatalf("nothing can be built on a closed database, got %v", created)
	}
}
