package module

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"sync"

	"core/internal/types"
	"core/orm"

	"github.com/bytecodealliance/wasmtime-go/v15"
	"github.com/labstack/echo/v4"
)

// Registry is the runtime module-lifecycle authority behind live
// activate/deactivate/reload (docs/adr/ADR-008 — supersedes Decision 1's
// "file-write + restart" design). Unlike the one-shot LoadModules/
// LoadGoModules that used to run once at boot, Registry stays alive for the
// life of the process:
//
//   - Boot loads EVERY discovered module (WASM and Go, active or not) —
//     "active" is no longer a load-time gate, it's a live, in-memory
//     request-time gate (IsTableActive / ActiveGateMiddleware). This is what
//     lets SetActive flip a module on/off with zero restart: the module was
//     already loaded, only its visibility changes.
//   - Each WASM module gets its OWN wasmtime.Store (the old code shared one
//     Store for every module) so Reload can drop just that module's Store and
//     let wasmtime's Go finalizer reclaim its memory, without disturbing any
//     other module sharing the same Engine.
//   - tableOwner attributes each table to the module whose Register() (Go) or
//     migration (WASM) FIRST created it — an extension merely adding columns
//     to another module's table (crminheritdemo → crm) never claims
//     ownership, so gating stays at the granularity the request-time
//     middleware can actually enforce: a whole table's routes, not a column.
type Registry struct {
	engine      *wasmtime.Engine
	linker      *wasmtime.Linker
	db          *orm.DB
	moduleRoots []string
	manager     *Manager
	opLogs      *OpLogRepository

	mu         sync.RWMutex
	active     map[string]bool   // module name -> active
	modType    map[string]string // module name -> module.json "type"
	tableOwner map[string]string // table name -> owning module name
	loadedWasm map[string]*loadedWasmModule
}

type loadedWasmModule struct {
	store *wasmtime.Store
	mod   types.Module
}

// newModuleStore builds a fresh per-module Store with its own WasiConfig.
// wasmtime's SetWasi takes ownership of the config it's given, so each Store
// needs its OWN WasiConfig instance — the old shared-Store design got away
// with building one WasiConfig once because there was only ever one Store.
func newModuleStore(engine *wasmtime.Engine) *wasmtime.Store {
	store := wasmtime.NewStore(engine)
	store.SetWasi(wasmtime.NewWasiConfig())
	return store
}

// NewRegistry wires a Registry over the shared Wasmtime engine/linker, DB,
// and module_root paths — the same inputs main.go used to pass straight to
// LoadModules/LoadGoModules.
func NewRegistry(engine *wasmtime.Engine, linker *wasmtime.Linker, db *orm.DB, moduleRoots []string) *Registry {
	return &Registry{
		engine:      engine,
		linker:      linker,
		db:          db,
		moduleRoots: moduleRoots,
		manager:     NewManager(moduleRoots),
		opLogs:      NewOpLogRepository(db),
		active:      map[string]bool{},
		modType:     map[string]string{},
		tableOwner:  map[string]string{},
		loadedWasm:  map[string]*loadedWasmModule{},
	}
}

// Boot loads every discovered module — WASM and Go, active or not — and
// records each one's active flag and table ownership. Replaces the old
// main.go pair of module.LoadModules + module.LoadGoModules calls.
func (r *Registry) Boot(ctx context.Context) []error {
	if err := bootstrapMigrationsTable(ctx, r.db); err != nil {
		return []error{fmt.Errorf("bootstrap module_migrations: %w", err)}
	}
	if err := bootstrapOperationLogTable(ctx, r.db); err != nil {
		return []error{fmt.Errorf("bootstrap module_operation_log: %w", err)}
	}

	modules, err := detector(r.moduleRoots)
	if err != nil {
		return []error{err}
	}

	r.mu.Lock()
	for _, mod := range modules {
		r.active[mod.Name] = mod.Active
		r.modType[mod.Name] = mod.Type
	}
	r.mu.Unlock()

	var (
		errMu sync.Mutex
		errs  []error
	)
	addErr := func(err error) {
		errMu.Lock()
		errs = append(errs, err)
		errMu.Unlock()
	}

	// WASM-type modules — loaded regardless of Active (the request-time gate
	// enforces "inactive" now, not load-time skipping), same priority-tiered
	// concurrency the old LoadModules used.
	priorityGroups := make(map[int][]types.Module)
	maxPriority := 0
	for _, mod := range modules {
		if mod.Type == "go" {
			continue
		}
		priorityGroups[mod.Priority] = append(priorityGroups[mod.Priority], mod)
		if mod.Priority > maxPriority {
			maxPriority = mod.Priority
		}
	}
	for p := 0; p <= maxPriority; p++ {
		group, ok := priorityGroups[p]
		if !ok {
			continue
		}
		var wg sync.WaitGroup
		for _, mod := range group {
			wg.Add(1)
			go func(mod types.Module) {
				defer wg.Done()
				store := newModuleStore(r.engine)
				tables, err := loadModule(ctx, r.db, store, r.linker, mod.WasmPath, mod.Name, nil)
				if err != nil {
					addErr(err)
					return
				}
				r.mu.Lock()
				r.loadedWasm[mod.Name] = &loadedWasmModule{store: store, mod: mod}
				for _, t := range tables {
					r.tableOwner[t] = mod.Name
				}
				r.mu.Unlock()
			}(mod)
		}
		wg.Wait()
	}

	// Go-type modules — registration order (unchanged from LoadGoModules).
	goMu.Lock()
	goMods := make([]GoModule, len(goModules))
	copy(goMods, goModules)
	goMu.Unlock()
	for _, m := range goMods {
		newTables, err := loadGoModule(ctx, r.db, m)
		if err != nil {
			addErr(err)
			continue
		}
		if len(newTables) > 0 {
			r.mu.Lock()
			for _, t := range newTables {
				r.tableOwner[t] = m.Name()
			}
			r.mu.Unlock()
		}
	}

	for _, name := range orm.RegisteredTableNames() {
		fields, ok := orm.MigrationFieldsForTable(name)
		if !ok {
			continue
		}
		if err := ensureIndexes(ctx, r.db, name, fields); err != nil {
			addErr(fmt.Errorf("ensure indexes %s: %w", name, err))
		}
	}

	return errs
}

// IsTableActive reports whether table's owning module is currently active.
// A table nothing in tableOwner claims (every core table — users, roles,
// notebook_page, picture, app_settings — none of which are module-owned) is
// never gated.
func (r *Registry) IsTableActive(table string) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	owner, owned := r.tableOwner[table]
	if !owned {
		return true
	}
	return r.active[owner]
}

// ActiveGateMiddleware 403s any request to a deactivated module's table.
// Passed as an extra middleware to ormserver.RegisterRoutes in main.go — it
// needs no change to that package's signature (middlewares is already
// variadic) and no import of it either (only echo.MiddlewareFunc).
func (r *Registry) ActiveGateMiddleware() echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			table := routeTable(c.Path())
			if table != "" && !r.IsTableActive(table) {
				return errorJSON(c, http.StatusForbidden, "MODULE_INACTIVE", "This module is currently deactivated.")
			}
			return next(c)
		}
	}
}

// routeTable extracts the table segment from an Echo-matched route pattern
// mounted under /api/v1, e.g. "/api/v1/crm/:id" -> "crm". RegisterSchema
// defaults a table's RoutePrefix to its table name (registry.go), so this is
// a table name whenever the route came from the generic CRUD surface.
func routeTable(routePattern string) string {
	const prefix = "/api/v1/"
	if !strings.HasPrefix(routePattern, prefix) {
		return ""
	}
	rest := strings.TrimPrefix(routePattern, prefix)
	if i := strings.IndexByte(rest, '/'); i >= 0 {
		rest = rest[:i]
	}
	return rest
}

// SetActive flips name's runtime gate and — only once that succeeds — persists
// the change to module.json via the same atomic write Manager.Patch always
// used. This ordering ("file state changes at the end of the operation") is
// the whole point: the gate takes effect immediately, in memory, before the
// disk write even starts.
func (r *Registry) SetActive(ctx context.Context, name string, want bool) (map[string]any, error) {
	if !want && name == appstoreModuleName {
		return nil, &ValidationError{Message: "the appstore module cannot deactivate itself."}
	}

	op := "deactivate"
	if want {
		op = "activate"
	}
	opLog := NewOpLogger(r.opLogs, name, op)
	opLog.Log("backend", "info", fmt.Sprintf("%s requested", op))

	r.mu.Lock()
	if _, known := r.active[name]; !known {
		r.mu.Unlock()
		return nil, ErrModuleNotFound
	}
	previous := r.active[name]
	r.active[name] = want
	r.mu.Unlock()
	opLog.Log("backend", "info", fmt.Sprintf("runtime gate set to active=%v — live immediately, no restart", want))

	updated, err := r.manager.Patch(ctx, name, map[string]any{"active": want})
	if err != nil {
		// Keep the on-disk file and the in-memory gate in agreement: if the
		// write failed, the gate never actually flipped from the operator's
		// point of view.
		r.mu.Lock()
		r.active[name] = previous
		r.mu.Unlock()
		opLog.Log("backend", "error", fmt.Sprintf("module.json write failed, rolled back: %v", err))
		return nil, err
	}
	opLog.Log("backend", "info", "module.json updated")
	return updated, nil
}

// Reload re-loads name without a backend restart — the "upgradable directly
// on run" primitive. For a WASM-type module this genuinely re-instantiates
// the (possibly replaced) .wasm binary and re-runs its migration; for a
// Go-type module there is no binary to hot-swap (its code is statically
// compiled into this same process), so Reload only re-validates its schema
// registration and says so in the log — a real code change to a Go module
// still needs a backend rebuild + restart, a Go-language constraint no
// runtime registry can route around.
func (r *Registry) Reload(ctx context.Context, name string) (map[string]any, error) {
	opLog := NewOpLogger(r.opLogs, name, "reload")

	r.mu.RLock()
	modType, known := r.modType[name]
	r.mu.RUnlock()
	if !known {
		return nil, ErrModuleNotFound
	}

	if modType == "go" {
		goMu.Lock()
		var target GoModule
		for _, m := range goModules {
			if m.Name() == name {
				target = m
				break
			}
		}
		goMu.Unlock()
		if target == nil {
			return nil, ErrModuleNotFound
		}
		opLog.Log("backend", "info", "go-type module: re-validating schema registration "+
			"(a code change needs a backend rebuild + restart, not a reload)")
		newTables, err := loadGoModule(ctx, r.db, target)
		if err != nil {
			opLog.Log("backend", "error", err.Error())
			return nil, err
		}
		if len(newTables) > 0 {
			r.mu.Lock()
			for _, t := range newTables {
				r.tableOwner[t] = name
			}
			r.mu.Unlock()
		}
		opLog.Log("backend", "info", "reload complete")
		return r.manager.Get(ctx, name)
	}

	modules, err := detector(r.moduleRoots)
	if err != nil {
		return nil, err
	}
	var target *types.Module
	for _, m := range modules {
		if m.Name == name {
			mm := m
			target = &mm
			break
		}
	}
	if target == nil {
		return nil, ErrModuleNotFound
	}

	store := newModuleStore(r.engine)
	tables, err := loadModule(ctx, r.db, store, r.linker, target.WasmPath, name, opLog)
	if err != nil {
		opLog.Log("backend", "error", err.Error())
		return nil, err
	}

	r.mu.Lock()
	r.loadedWasm[name] = &loadedWasmModule{store: store, mod: *target}
	for _, t := range tables {
		r.tableOwner[t] = name
	}
	r.mu.Unlock()
	opLog.Log("backend", "info", "reload complete — previous Store dropped for GC")

	return r.manager.Get(ctx, name)
}

// Logs returns name's recent operation log entries, most recent operation
// first (OpLogRepository.forModule already sorts newest-first).
func (r *Registry) Logs(ctx context.Context, name string) ([]ModuleOperationLog, error) {
	return r.opLogs.forModule(ctx, name, 500)
}
