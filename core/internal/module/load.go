package module

import (
	"context"
	"encoding/json"
	"fmt"

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

	common.Logger.Info("🔌 Module chargé: ", zap.String("name", name))

	return nil
}

func LoadModules(ctx context.Context, store *wasmtime.Store, linker *wasmtime.Linker, conn *pgx.Conn, moduleRoots []string) []error {
	modulePaths, err := detector(moduleRoots)
	if err != nil {
		return []error{err}
	}

	var errList []error

	for _, modules := range modulePaths {
		common.Logger.Info("Loading module:", zap.String("", modules.Path))
		if err := loadModule(ctx, store, linker, conn, modules.WasmPath, modules.Name); err != nil {
			errList = append(errList, err)
		}
	}

	return errList
}
