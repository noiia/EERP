// Command app is the EERP backend entry point: flags and config loading only.
// Everything else — validation, database, modules, routes, background jobs —
// lives in internal/app so it can be tested.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"core/internal/app"
	"core/internal/common"
	"core/internal/types"

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

	cfg, err := common.DecodeJSON[*types.Config](*configFilePtr)
	if err != nil {
		common.Logger.Fatal("❌ Error reading config file", zap.Error(err))
	}
	cfg.ResolvePaths(filepath.Dir(*configFilePtr))

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	a, err := app.Build(ctx, cfg, *configFilePtr, *debugPtr)
	if err != nil {
		common.Logger.Fatal("❌ Error building the app", zap.Error(err))
	}
	defer a.Close()

	if err := a.Run(ctx); err != nil {
		common.Logger.Error("server stopped with error", zap.Error(err))
	}
}
