package main

import (
	"context"
	"core/internal/common"
	"core/internal/module"
	"core/internal/types"
	"core/orm"
	"flag"
	"fmt"

	"github.com/bytecodealliance/wasmtime-go/v15"
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
	dbConf := orm.Config{DSN: dbLink, MaxConns: configContent.MaxConns, MinConns: configContent.MinConns, Debug: *debugPtr}

	if err := dbConf.Validate(); err != nil {
		common.Logger.Error("❌ Error validating db conf:", zap.Error(err))
	}

	db, err := orm.Open(context.Background(), dbConf)
	if err != nil {
		common.Logger.Error("❌ Error on openning db pool : ", zap.Error(err))
	}
	defer db.Close()

	engine := wasmtime.NewEngine()
	store := wasmtime.NewStore(engine)

	linker := wasmtime.NewLinker(engine)

	if err := linker.FuncWrap("host", "log", func(ptr int32, len int32) {
		common.Logger.Info("📦 WASM LOG CALLED")
	}); err != nil {
		common.Logger.Error("❌ FuncWraping error : ", zap.Error(err))
	}

	// Load modules
	errList := module.LoadModules(context.Background(), store, linker, configContent.ModuleRoot)
	for i := range errList {
		common.Logger.Error("❌ Error loading modules:", zap.Error(errList[i]))
	}
}
