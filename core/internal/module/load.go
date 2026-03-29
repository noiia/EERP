package module

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"

	"core/internal/common"
	"core/internal/types"

	"github.com/bytecodealliance/wasmtime-go/v15"
	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"
)

func loadModule(ctx context.Context, store *wasmtime.Store, linker *wasmtime.Linker, conn *pgx.Conn, path string, name string) error {
	module, err := wasmtime.NewModuleFromFile(store.Engine, path)
	if err != nil {
		return err
	}

	instance, err := linker.Instantiate(store, module)
	if err != nil {
		return err
	}

	migrate := instance.GetFunc(store, "migrate")
	migrateLen := instance.GetFunc(store, "migrate_len")
	if migrate != nil && migrateLen != nil {
		result, err := migrate.Call(store)
		if err != nil {
			return err
		}

		ptr := result.(int32)

		lenResult, err := migrateLen.Call(store)
		if err != nil {
			return err
		}

		length := lenResult.(int32)

		// Read memory from WASM instance
		memory := instance.GetExport(store, "memory").Memory()
		if memory == nil {
			return fmt.Errorf("memory export not found")
		}

		data := memory.UnsafeData(store)
		if int(ptr)+int(length) > len(data) {
			return fmt.Errorf("invalid pointer/length: ptr=%d, len=%d, memory_size=%d", ptr, length, len(data))
		}

		migrationJSON := string(data[ptr : ptr+length])

		var m types.Migration
		if err := json.Unmarshal([]byte(migrationJSON), &m); err != nil {
			return err
		}

		if err := applyMigration(ctx, conn, name, m); err != nil {
			return err
		}
	}

	common.Logger.Debug("🔌 Module chargé: ", zap.String("name", name))

	return nil
}

func LoadModules(ctx context.Context, store *wasmtime.Store, linker *wasmtime.Linker, conn *pgx.Conn, moduleRoots []string) []error {
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
			if mod.Active {
				wg.Add(1)
				go func(mod types.Module) {
					defer wg.Done()
					common.Logger.Debug("Loading module:", zap.String("name", mod.Name), zap.Int("priority", mod.Priority))
					if err := loadModule(ctx, store, linker, conn, mod.WasmPath, mod.Name); err != nil {
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
