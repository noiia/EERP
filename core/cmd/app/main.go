package main

import (
	"context"
	"core/internal/common"
	"core/internal/module"
	"core/internal/types"
	ormconfig "core/orm/pool/config"
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"github.com/bytecodealliance/wasmtime-go/v15"
	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"
)

func main() {
	configFilePtr := flag.String("config", "", "MUST TO HAVE -- config file path")

	debugPtr := flag.Bool("debug", false, "define log level between :\n- 'INFO' : false \n- 'DEBUG' : true")

	flag.Parse()

	if err := common.InitLogger(*debugPtr); err != nil {
		panic(err)
	}

	configContent, err := common.DecodeJSON[*types.Config](*configFilePtr)
	if err != nil {
		common.Logger.Error("❌ Error reading config file:", zap.Error(err))
	}

	dbLink := fmt.Sprintf("postgres://%s:%s@%s:%d/%s", configContent.DbUser, configContent.DbPassword, configContent.DbHost, configContent.DbPort, configContent.DbName)
	dbConf := ormconfig.Config{DSN: dbLink, MaxConns: configContent.MaxConns, MinConns: configContent.MinConns, Debug: *debugPtr}

	if err := dbConf.Validate(); err != nil {
		common.Logger.Error("❌ Error validating db conf:", zap.Error(err))
	}

	conn, err := pgx.Connect(context.Background(), dbLink)
	if err != nil {
		panic(err)
	}
	defer func() {
		if err := conn.Close(context.Background()); err != nil {
			common.Logger.Error("❌ Error occurs on pgx closing connection :  ", zap.Error(err))
		}
	}()

	engine := wasmtime.NewEngine()
	store := wasmtime.NewStore(engine)

	linker := wasmtime.NewLinker(engine)

	if err := linker.FuncWrap("host", "log", func(ptr int32, len int32) {
		common.Logger.Info("📦 WASM LOG CALLED")
	}); err != nil {
		common.Logger.Error("❌ FuncWraping error : ", zap.Error(err))
	}

	// Load modules
	errList := module.LoadModules(context.Background(), store, linker, conn, configContent.ModuleRoot)
	for i := range errList {
		common.Logger.Error("❌ Error loading modules:", zap.Error(errList[i]))
	}

	b, err := os.ReadFile("../../schema.sql")
	if err != nil {
		common.Logger.Error("❌ Error loading schema.sql:", zap.Error(err))
	}

	_, err = conn.Exec(context.Background(), string(b))
	if err != nil {
		common.Logger.Error("❌ Error inserting schema.sql:", zap.Error(err))
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
		common.Logger.Error("❌ Error inserting vente:", zap.Error(err))
	}

	common.Logger.Info("✅ Vente insérée")
	common.Logger.Info("📄 Payload final:", zap.String("payload", string(payload)))
}
