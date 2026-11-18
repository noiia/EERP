package project

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"testing"

	"core/internal/auth"
	"core/orm"
	"core/orm/access"

	"github.com/google/uuid"
)

// handler is the handler the rules run under, on the fixture's database, for
// calls that don't go through Echo (h.check).
func (f *fixture) handler() *Handler {
	f.t.Helper()
	return NewHandler(f.app.DB, auth.NewPermissionRepository(f.app.DB))
}

// ctxFor stamps a context the way JWTMiddleware does (the caller and its
// tenant), for calls that don't go through Echo.
func ctxFor(who auth.Identity) context.Context {
	ctx := auth.SetIdentity(context.Background(), who)
	ctx = access.WithTenant(ctx, who.TenantID)
	return access.WithGroups(ctx, who.Groups)
}

// TestCheck_SeesRowsOfItsTransaction: the rules must read through the
// executor they were handed, not the pool. An import applies a whole file
// inside one orm.Transact, so a row written earlier in that transaction has
// to be visible to the checks of the rows written after it.
func TestCheck_SeesRowsOfItsTransaction(t *testing.T) {
	f := newFixture(t)
	h := f.handler()
	m := uuid.New()
	ctx := ctxFor(f.caller(m))
	p := f.project(m, "everyone")
	first := f.stage(p, "New")

	var parent uuid.UUID // lives only inside the transaction below
	var got map[string]any
	var seedErr, checkErr error
	rollback := errors.New("roll the seeding transaction back")

	txErr := orm.Transact(ctx, f.app.DB, func(tx *orm.Tx) error {
		var stage uuid.UUID
		if err := tx.QueryRow(ctx, `SELECT id FROM project_stage WHERE project_id = $1 AND deleted_at IS NULL
			ORDER BY sequence, created_at LIMIT 1`, p).Scan(&stage); err != nil {
			seedErr = err
			return err
		}
		if err := tx.QueryRow(ctx, `INSERT INTO project_task (tenant_id, project_id, stage_id, name)
			VALUES ($1, $2, $3, 'T1') RETURNING id`, f.tenant, p, stage).Scan(&parent); err != nil {
			seedErr = err
			return err
		}
		got, checkErr = h.check(ctx, tx, "project_task", opCreate, uuid.Nil, map[string]any{
			"project_id": p.String(), "name": "child", "parent_id": parent.String(),
		})
		return rollback
	})
	if seedErr != nil {
		t.Fatalf("seed on the transaction: %v", seedErr)
	}
	if !errors.Is(txErr, rollback) {
		t.Fatalf("transaction: %v, want it rolled back", txErr)
	}
	if checkErr != nil {
		t.Fatalf("check on its own transaction: %v, want the uncommitted parent task accepted", checkErr)
	}
	if got["stage_id"] != first.String() {
		t.Fatalf("body %v, want stage_id %s (the project's first stage)", got, first)
	}

	// The same write on the pool: the parent task was never committed, so it
	// isn't visible there and the rules refuse parent_id.
	_, err := h.check(ctx, f.app.DB, "project_task", opCreate, uuid.Nil, map[string]any{
		"project_id": p.String(), "name": "child", "parent_id": parent.String(),
	})
	var rej *rejection
	if !errors.As(err, &rej) || rej.status != http.StatusUnprocessableEntity || !slices.Contains(rej.fields, "parent_id") {
		t.Fatalf("check on the pool: %v, want a 422 rejection on parent_id", err)
	}
}

// TestCheck_ManagerOnly: check answers the same 404 as the HTTP path when the
// caller may not see the row an update or delete writes against.
func TestCheck_ManagerOnly(t *testing.T) {
	f := newFixture(t)
	h := f.handler()
	m := uuid.New()
	p := f.project(m, "members") // hidden from everyone but its manager and its members
	a, b := f.task(p, nil, nil), f.task(p, nil, nil)
	dep := f.dependency(p, a, b)

	if _, err := h.check(ctxFor(f.caller(m)), f.app.DB, "project_task_dependency", opDelete, dep, nil); err != nil {
		t.Errorf("manager deletes a dependency: %v, want accepted", err)
	}
	stranger := f.caller(uuid.New()) // neither the manager nor an assignee
	if _, err := h.check(ctxFor(stranger), f.app.DB, "project_task_dependency", opDelete, dep, nil); !errors.Is(err, errNotFound) {
		t.Errorf("stranger deletes a dependency of a members-only project: %v, want %v", err, errNotFound)
	}
}
