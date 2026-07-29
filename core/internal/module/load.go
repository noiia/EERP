package module

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"

	"core/internal/common"
	"core/internal/types"
	"core/orm"

	"github.com/bytecodealliance/wasmtime-go/v15"
	"go.uber.org/zap"
)

// loadModule instantiates path's WASM binary into store, runs its optional
// _start/migrate exports, and returns the names of every table its migration
// touches (used by Registry to attribute table ownership for the runtime
// active-gate — see runtime.go). opLog is nilable: boot-time callers pass nil
// and get today's zap-only behavior; Registry.Reload passes a real *OpLogger
// so an operator can see each step of a live reload.
func loadModule(ctx context.Context, db *orm.DB, store *wasmtime.Store, linker *wasmtime.Linker, path string, name string, opLog *OpLogger) ([]string, error) {
	opLog.Log("backend", "info", fmt.Sprintf("instantiating %s from %s", name, path))
	module, err := wasmtime.NewModuleFromFile(store.Engine, path)
	if err != nil {
		return nil, err
	}

	instance, err := linker.Instantiate(store, module)
	if err != nil {
		return nil, err
	}

	if start := instance.GetFunc(store, "_start"); start != nil {
		if _, err := start.Call(store); err != nil {
			var wasmErr *wasmtime.Error
			if errors.As(err, &wasmErr) {
				if code, ok := wasmErr.ExitStatus(); ok && code == 0 {
					// normal exit — runtime initialised successfully
				} else {
					return nil, fmt.Errorf("module %s: _start: %w", name, err)
				}
			} else {
				return nil, fmt.Errorf("module %s: _start: %w", name, err)
			}
		}
	}

	var tables []string

	migrate := instance.GetFunc(store, "migrate")
	migrateLen := instance.GetFunc(store, "migrate_len")
	if migrate != nil && migrateLen != nil {
		result, err := migrate.Call(store)
		if err != nil {
			return nil, err
		}

		ptr := result.(int32)

		lenResult, err := migrateLen.Call(store)
		if err != nil {
			return nil, err
		}

		length := lenResult.(int32)

		// Read memory from WASM instance
		memory := instance.GetExport(store, "memory").Memory()
		if memory == nil {
			return nil, fmt.Errorf("memory export not found")
		}

		data := memory.UnsafeData(store)
		if int(ptr)+int(length) > len(data) {
			return nil, fmt.Errorf("invalid pointer/length: ptr=%d, len=%d, memory_size=%d", ptr, length, len(data))
		}

		migrationJSON := string(data[ptr : ptr+length])

		var m types.Migration
		if err := json.Unmarshal([]byte(migrationJSON), &m); err != nil {
			return nil, err
		}

		if err := applyMigration(ctx, db, name, m, opLog); err != nil {
			return nil, err
		}

		if err := registerSchemas(m); err != nil {
			return nil, fmt.Errorf("module %s: register schema: %w", name, err)
		}

		seen := map[string]struct{}{}
		for _, op := range m.Operations {
			if _, ok := seen[op.Table]; ok {
				continue
			}
			seen[op.Table] = struct{}{}
			tables = append(tables, op.Table)
		}
	}

	common.Logger.Debug("🔌 Module chargé: ", zap.String("name", name))
	opLog.Log("backend", "info", fmt.Sprintf("%s loaded", name))

	return tables, nil
}

// baseModelFields are the standard columns every module table inherits.
// They match model.BaseModel: uuid PK, timestamps, and soft-delete.
var baseModelFields = []orm.SchemaField{
	{Column: "id", IsPK: true},
	{Column: "created_at"},
	{Column: "updated_at"},
	{Column: "deleted_at", Nullable: true, SoftDel: true},
}

// registerSchemas builds an ORM schema entry for every table touched by m.
// This lets BuildHandlers discover and mount routes without any per-module
// code in main.go.
func registerSchemas(m types.Migration) error {
	// Group columns by table, prepending BaseModel fields.
	tables := map[string][]orm.SchemaField{}
	for _, op := range m.Operations {
		if _, seen := tables[op.Table]; !seen {
			tables[op.Table] = append([]orm.SchemaField{}, baseModelFields...)
		}
		if op.Type == "add_column" {
			tables[op.Table] = append(tables[op.Table], orm.SchemaField{
				Column:   op.Column,
				Nullable: op.Nullable,
			})
		}
	}

	for table, fields := range tables {
		if err := orm.RegisterSchema(table, fields); err != nil {
			return fmt.Errorf("table %s: %w", table, err)
		}
	}
	return nil
}

func LoadModules(ctx context.Context, db *orm.DB, store *wasmtime.Store, linker *wasmtime.Linker, moduleRoots []string) []error {
	if err := bootstrapMigrationsTable(ctx, db); err != nil {
		return []error{fmt.Errorf("bootstrap module_migrations: %w", err)}
	}

	modules, err := detector(moduleRoots)
	if err != nil {
		return []error{err}
	}

	priorityGroups := make(map[int][]types.Module)
	maxPriority := 0
	for _, mod := range modules {
		priorityGroups[mod.Priority] = append(priorityGroups[mod.Priority], mod)
		if mod.Priority > maxPriority {
			maxPriority = mod.Priority
		}
	}

	var (
		errMu   sync.Mutex
		errList []error
	)

	for p := 0; p <= maxPriority; p++ {
		group, ok := priorityGroups[p]
		if !ok {
			continue
		}
		var wg sync.WaitGroup
		for _, mod := range group {
			if mod.Active && mod.Type != "go" {
				wg.Add(1)
				go func(mod types.Module) {
					defer wg.Done()
					common.Logger.Debug("Loading module:", zap.String("name", mod.Name), zap.Int("priority", mod.Priority))
					if _, err := loadModule(ctx, db, store, linker, mod.WasmPath, mod.Name, nil); err != nil {
						errMu.Lock()
						errList = append(errList, err)
						errMu.Unlock()
					}
				}(mod)
			}
		}
		wg.Wait()
	}

	return errList
}
