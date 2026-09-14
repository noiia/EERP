package server

import (
	"core/orm"
	"core/orm/internal/crud"
	"core/orm/internal/handler"
	"core/orm/internal/registry"
)

// BuildHandlers constructs a GenericHandler for every non-excluded registered table.
// Call this after all Register[T] / AutoScan calls have completed.
func BuildHandlers(app *orm.App) map[string]*handler.GenericHandler {
	all := registry.All()
	handlers := make(map[string]*handler.GenericHandler, len(all))
	for _, meta := range all {
		repo := crud.NewRepository(app.DB, meta)
		svc := crud.NewService(repo, meta)
		handlers[meta.TableName] = handler.NewGenericHandler(svc, meta)
	}
	return handlers
}
