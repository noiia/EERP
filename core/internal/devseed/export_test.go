package devseed

import (
	"context"

	"core/orm"
)

// SetIndexer replaces the post-seed search indexer. Test-only (compiled only
// into this package's tests, so it isn't dead production code): a handler test
// must not build trigram indexes on whatever tables the shared test database
// holds.
func (h *Handler) SetIndexer(f func(context.Context, *orm.DB) ([]string, error)) { h.index = f }
