package main

import (
	"context"
	"core/internal/common"
	"core/internal/module"
	"core/internal/types"
	_ "core/modules/all"
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

	app, err := orm.New(dbConf, common.Logger)
	if err != nil {
		common.Logger.Fatal("❌ Error opening db pool", zap.Error(err))
	}
	defer app.Close()

	engine := wasmtime.NewEngine()
	store := wasmtime.NewStore(engine)
	wasiCfg := wasmtime.NewWasiConfig()
	store.SetWasi(wasiCfg)
	linker := wasmtime.NewLinker(engine)

	if err := linker.DefineWasi(); err != nil {
		common.Logger.Fatal("❌ DefineWasi error", zap.Error(err))
	}

	if err := linker.FuncWrap("host", "log", func(ptr int32, len int32) {
		common.Logger.Info("📦 WASM LOG CALLED")
	}); err != nil {
		common.Logger.Fatal("❌ FuncWrap error", zap.Error(err))
	}

	for _, err := range module.LoadModules(context.Background(), app.DB, store, linker, configContent.ModuleRoot) {
		common.Logger.Error("❌ Error loading WASM module", zap.Error(err))
	}

	for _, err := range module.LoadGoModules(context.Background(), app.DB) {
		common.Logger.Error("❌ Error loading Go module", zap.Error(err))
	}

	// ── Build server ──────────────────────────────────────────────────────────
	srvCfg := ormserver.Config{
		Addr: fmt.Sprintf("%s:%d", configContent.PublicAddress, configContent.BackendPort),
	}
	srv := ormserver.New(app, srvCfg)
	srv.RegisterRoutes(ormserver.BuildHandlers(app))

	for _, r := range srv.Routes() {
		common.Logger.Info("route", zap.String("method", r.Method), zap.String("path", r.Path))
	}

	// ── Graceful shutdown ─────────────────────────────────────────────────────
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	common.Logger.Info("server starting", zap.String("addr", srvCfg.Addr))
	if err := srv.Start(ctx); err != nil {
		common.Logger.Error("server stopped with error", zap.Error(err))
	}
}
