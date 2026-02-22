package module

import (
	"context"
	"encoding/json"
	"fmt"

	"core/src/types"

	"github.com/bytecodealliance/wasmtime-go/v15"
	"github.com/jackc/pgx/v5"
)

func loadModule(ctx context.Context, store *wasmtime.Store, linker *wasmtime.Linker, conn *pgx.Conn, path string, name string) {
	module, err := wasmtime.NewModuleFromFile(store.Engine, path)
	if err != nil {
		panic(err)
	}

	instance, err := linker.Instantiate(store, module)
	if err != nil {
		panic(err)
	}

	migrate := instance.GetFunc(store, "migrate")
	migrateLen := instance.GetFunc(store, "migrate_len")
	if migrate != nil && migrateLen != nil {
		result, err := migrate.Call(store)
		if err != nil {
			panic(err)
		}

		ptr := result.(int32)

		lenResult, err := migrateLen.Call(store)
		if err != nil {
			panic(err)
		}

		length := lenResult.(int32)

		// Read memory from WASM instance
		memory := instance.GetExport(store, "memory").Memory()
		if memory == nil {
			panic("memory export not found")
		}

		data := memory.UnsafeData(store)
		if int(ptr)+int(length) > len(data) {
			panic(fmt.Sprintf("invalid pointer/length: ptr=%d, len=%d, memory_size=%d", ptr, length, len(data)))
		}

		migrationJSON := string(data[ptr : ptr+length])

		var m types.Migration
		json.Unmarshal([]byte(migrationJSON), &m)

		applyMigration(ctx, conn, name, m)
	}

	fmt.Println("🔌 Module chargé:", name)
}

func LoadModules(ctx context.Context, store *wasmtime.Store, linker *wasmtime.Linker, conn *pgx.Conn, moduleRoots []string) error {
	modulePaths, err := detector(moduleRoots)
	if err != nil {
		return err
	}

	for _, modules := range modulePaths {
		fmt.Println("Loading module:", modules.Path)
		loadModule(ctx, store, linker, conn, modules.WasmPath, modules.Name)
	}

	return nil
}
