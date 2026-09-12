package crud

import "core/orm/internal/registry"

// NewServiceFromRepo constructs a Service with any repoLayer implementation.
// For testing only — allows injecting a mock repository.
func NewServiceFromRepo(repo repoLayer, meta registry.TableMeta) *Service {
	return &Service{repo: repo, meta: meta}
}
