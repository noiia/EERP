package handler

import (
	"core/orm/internal/crud"
	"core/orm/internal/registry"
)

// NewGenericHandlerFromSvc constructs a handler from any svcLayer implementation.
// For testing only — allows injecting a mock service.
func NewGenericHandlerFromSvc(svc svcLayer, meta registry.TableMeta) *GenericHandler {
	return &GenericHandler{svc: svc, meta: meta}
}

// expose crud types so tests in handler_test package can reference them
var _ = crud.ErrNotFound
