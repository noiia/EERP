package appstore

import "testing"

// appstore ships no ORM models — its data lives in module.json files, served
// by the dedicated /api/v1/modules API (internal/module), never the generic
// CRUD surface. Register() is a deliberate no-op; this pins that it stays
// error-free.
func TestAppstore_RegisterIsANoOp(t *testing.T) {
	if err := (&appstoreModule{}).Register(); err != nil {
		t.Fatalf("register: %v", err)
	}
}
