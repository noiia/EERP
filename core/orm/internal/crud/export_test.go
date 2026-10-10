package crud

import (
	"core/orm/internal/registry"
	"core/orm/pool/executor"
)

// NewServiceFromRepo constructs a Service with any repoLayer implementation.
// For testing only — allows injecting a mock repository.
func NewServiceFromRepo(repo repoLayer, meta registry.TableMeta) *Service {
	return &Service{repo: repo, meta: meta}
}

// ReadCache is the cache interface lookup/store use, for stubbing.
type ReadCache = readCache

// StubCache makes every repository use c as its read cache until the
// returned restore func runs.
func StubCache(c ReadCache) (restore func()) {
	prev := cacheFor
	cacheFor = func(executor.Executor) (readCache, string) { return c, "testdb" }
	return func() { cacheFor = prev }
}
