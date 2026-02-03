package main

import (
	"context"
	"core/src/common"
	"core/src/module"
	"core/src/types"
	"encoding/json"
	"flag"
	"fmt"
	"log"

	"github.com/bytecodealliance/wasmtime-go/v15"
	"github.com/jackc/pgx/v5"
)

func main() {
	conn, err := pgx.Connect(context.Background(), "postgres://postgres:postgres@localhost:5432/poc")
	if err != nil {
		panic(err)
	}
	defer conn.Close(context.Background())

	engine := wasmtime.NewEngine()
	store := wasmtime.NewStore(engine)

	linker := wasmtime.NewLinker(engine)

	// Host function: log
	linker.FuncWrap("host", "log", func(ptr int32, len int32) {
		fmt.Println("📦 WASM LOG CALLED")
	})

	configFilePtr := flag.String("config", "", "MUST TO HAVE -- config file path")

	flag.Parse()

	configContent, err := common.DecodeJSON[*types.Config](*configFilePtr)
	if err != nil {
		log.Fatal("❌ Error reading config file:", err)
	}

	// Load modules
	err = module.LoadModules(context.Background(), store, linker, conn, configContent.ModuleRoot)
	if err != nil {
		log.Fatal("❌ Error loading modules:", err)
	}

	// Fake insert
	vente := types.Vente{
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
