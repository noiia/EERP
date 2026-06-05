package main

import (
	"context"
	"core/internal/common"
	"core/internal/module"
	"core/internal/types"
	"core/orm"
	ormserver "core/orm/server"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/bytecodealliance/wasmtime-go/v15"
	"go.uber.org/zap"
)

func main() {
	configFilePtr := flag.String("config", "", "MUST TO HAVE -- config file path")
	debugPtr := flag.Bool("debug", false, "define log level between :\n- 'INFO' : false \n- 'DEBUG' : true")
	generateConfig := flag.Bool("generate-config", false, "print a default config template to stdout and exit")

	flag.Parse()

	if *generateConfig {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		_ = enc.Encode(types.DefaultConfig())
		return
	}

	if err := common.InitLogger(*debugPtr); err != nil {
		panic(err)
	}

	configContent, err := common.DecodeJSON[*types.Config](*configFilePtr)
	if err != nil {
		common.Logger.Fatal("❌ Error reading config file", zap.Error(err))
	}

	if notExists, _ := common.FileNotExists(configContent.ApiConfigPath); !notExists {
		if err := orm.LoadAPIConfig(configContent.ApiConfigPath); err != nil {
			common.Logger.Warn("could not load api.yaml", zap.String("path", configContent.ApiConfigPath), zap.Error(err))
		}
	}

	dbLink := fmt.Sprintf("postgres://%s:%s@%s:%d/%s", configContent.DbUser, configContent.DbPassword, configContent.DbHost, configContent.DbPort, configContent.DbName)
	dbConf := orm.Config{DSN: dbLink, MaxConns: configContent.MaxConns, MinConns: configContent.MinConns, Debug: *debugPtr}

	if err := dbConf.Validate(); err != nil {
		common.Logger.Fatal("❌ Error validating db conf", zap.Error(err))
	}

	orm.AutoScan("")

	app, err := orm.New(dbConf, common.Logger)
	if err != nil {
		common.Logger.Fatal("❌ Error opening db pool", zap.Error(err))
	}
	defer app.Close()

	engine := wasmtime.NewEngine()
	store := wasmtime.NewStore(engine)
	linker := wasmtime.NewLinker(engine)

	if err := linker.FuncWrap("host", "log", func(ptr int32, len int32) {
		common.Logger.Info("📦 WASM LOG CALLED")
	}); err != nil {
		common.Logger.Fatal("❌ FuncWrap error", zap.Error(err))
	}

	// Load modules
	errList := module.LoadModules(store, linker, configContent.ModuleRoot)
	for i := range errList {
		common.Logger.Error("❌ Error loading module", zap.Error(errList[i]))
	}

	// ── Build server ──────────────────────────────────────────────────────────
	srvCfg := ormserver.Config{
		Addr: fmt.Sprintf("%s:%d", configContent.PublicAddress, configContent.BackendPort),
	}
	srv := ormserver.New(app, srvCfg)
	srv.RegisterRoutes(ormserver.BuildHandlers(app))

	// ── Graceful shutdown ─────────────────────────────────────────────────────
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	common.Logger.Info("server starting", zap.String("addr", srvCfg.Addr))
	if err := srv.Start(ctx); err != nil {
		common.Logger.Error("server stopped with error", zap.Error(err))
	}
}
