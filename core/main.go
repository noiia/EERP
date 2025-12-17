package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"

	"github.com/bytecodealliance/wasmtime-go/v15"
	"github.com/jackc/pgx/v5"
)

type Vente struct {
	ID         string                 `json:"id"`
	Montant    float64                `json:"montant"`
	Extensions map[string]interface{} `json:"extensions"`
}

type Migration struct {
	Entity     string      `json:"entity"`
	Version    int         `json:"version"`
	Operations []Operation `json:"operations"`
}

type Operation struct {
	Type     string `json:"type"`
	Table    string `json:"table"`
	Column   string `json:"column"`
	SQLType  string `json:"sql_type"`
	Nullable bool   `json:"nullable"`
}

func main() {
	// DB
	conn, err := pgx.Connect(context.Background(), "postgres://postgres:postgres@localhost:5432/poc")
	if err != nil {
		panic(err)
	}
	defer conn.Close(context.Background())

	// WASM runtime
	engine := wasmtime.NewEngine()
	store := wasmtime.NewStore(engine)

	linker := wasmtime.NewLinker(engine)

	// Host function: log
	linker.FuncWrap("host", "log", func(ptr int32, len int32) {
		fmt.Println("📦 WASM LOG CALLED")
	})

	loadModule(context.Background(), store, linker, conn, "../modules/vente/target/wasm32-unknown-unknown/release/vente.wasm", "vente")
	loadModule(context.Background(), store, linker, conn, "../modules/vente_particulier/target/wasm32-unknown-unknown/release/vente_particulier.wasm", "vente_particulier")

	// Fake insert
	vente := Vente{
		ID:      "11111111-1111-1111-1111-111111111111",
		Montant: 120.50,
		Extensions: map[string]interface{}{
			"type_client": "particulier",
		},
	}

	payload, _ := json.Marshal(vente)

	_, err = conn.Exec(context.Background(),
		"INSERT INTO vente (id, montant, extensions) VALUES ($1, $2, $3)",
		vente.ID, vente.Montant, payload,
	)
	if err != nil {
		log.Fatal(err)
	}

	fmt.Println("✅ Vente insérée")
	fmt.Println("📄 Payload final:", string(payload))
}

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
		// Call migrate to get the pointer
		result, err := migrate.Call(store)
		if err != nil {
			panic(err)
		}

		ptr := result.(int32)

		// Call migrate_len to get the length
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

		var m Migration
		json.Unmarshal([]byte(migrationJSON), &m)

		applyMigration(ctx, conn, name, m)
	}

	fmt.Println("🔌 Module chargé:", name)
}

func applyMigration(ctx context.Context, conn *pgx.Conn, module string, m Migration) error {
	var exists bool

	err := conn.QueryRow(ctx,
		"SELECT EXISTS (SELECT 1 FROM module_migrations WHERE module_name=$1 AND version=$2)",
		module, m.Version,
	).Scan(&exists)
	if err != nil {
		return err
	}

	if exists {
		fmt.Println("↪️ Migration déjà appliquée:", module, m.Version)
		return nil
	}

	for _, op := range m.Operations {
		if op.Type == "add_column" {
			sql := fmt.Sprintf(
				"ALTER TABLE %s ADD COLUMN IF NOT EXISTS %s %s",
				op.Table,
				op.Column,
				op.SQLType,
			)
			fmt.Println("🛠️", sql)
			if _, err := conn.Exec(ctx, sql); err != nil {
				return err
			}
		}
	}

	_, err = conn.Exec(ctx,
		"INSERT INTO module_migrations (module_name, version) VALUES ($1, $2)",
		module, m.Version,
	)

	fmt.Println("✅ Migration appliquée:", module, m.Version)
	return err
}
