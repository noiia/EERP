package dbmanage

import (
	"context"
	"fmt"

	"core/internal/auth"
	"core/internal/module"
	"core/orm"

	"github.com/bytecodealliance/wasmtime-go/v15"
)

// Provisioner builds a fully-usable EERP database from an empty one — the
// exact same path core/cmd/app/main.go's normal boot takes
// (module.NewRegistry(...).Boot(ctx) + auth.SeedDevAdmin), reused here rather
// than duplicated. Safe to call against an ALREADY-provisioned database too:
// Boot()'s underlying ensureTable/ensureColumns are idempotent (IF NOT
// EXISTS throughout — core/internal/module/migration.go) and, since the
// go_module.go fix that made this whole feature possible, no longer gated
// behind a process-global in-memory diff that only holds true once per
// process — see that fix's own doc comment for the full story.
type Provisioner struct {
	Engine      *wasmtime.Engine
	Linker      *wasmtime.Linker
	ModuleRoots []string
	Environment string
}

// Provision runs schema creation + default-admin seeding against db. Callers
// pass either a throwaway *orm.DB pointed at a brand-new database (create.go)
// or the app's live, already-swapped *orm.DB (switch.go) — either way this
// function itself holds no state and is safe to call repeatedly.
func (p Provisioner) Provision(ctx context.Context, db *orm.DB) error {
	return p.ProvisionWithProgress(ctx, db, nil)
}

// ProvisionWithProgress is Provision plus a done/total callback forwarded
// straight to module.Registry.BootWithProgress — see that method's own doc
// comment for what done/total mean. onProgress may be nil (same as calling
// Provision).
func (p Provisioner) ProvisionWithProgress(ctx context.Context, db *orm.DB, onProgress func(done, total int)) error {
	registry := module.NewRegistry(p.Engine, p.Linker, db, p.ModuleRoots)
	if errs := registry.BootWithProgress(ctx, onProgress); len(errs) > 0 {
		return fmt.Errorf("dbmanage: provision schema: %w", errs[0])
	}
	if err := auth.SeedDevAdmin(ctx, db, p.Environment); err != nil {
		return fmt.Errorf("dbmanage: seed default admin: %w", err)
	}
	return nil
}
