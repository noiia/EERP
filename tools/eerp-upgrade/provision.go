package main

import (
	"context"
	"fmt"

	"core/internal/common"
	"core/internal/dbmanage"
	"core/internal/types"
	_ "core/modules/all"
	"core/orm"

	"github.com/bytecodealliance/wasmtime-go/v50"
)

// provision runs today's boot migration (all modules + default admin) on dbName,
// the same wiring as internal/app.Build.
func provision(ctx context.Context, cfg *types.Config, dbName string) error {
	c := *cfg
	c.DbName = dbName
	app, err := orm.New(c.PoolConfig(c.DSN()), common.Logger)
	if err != nil {
		return fmt.Errorf("open %s: %w", dbName, err)
	}
	defer app.Close()
	engine := wasmtime.NewEngine()
	linker := wasmtime.NewLinker(engine)
	if err := linker.DefineWasi(); err != nil {
		return fmt.Errorf("define WASI: %w", err)
	}
	if err := linker.FuncWrap("host", "log", func(ptr int32, len int32) {}); err != nil {
		return fmt.Errorf("wrap host log: %w", err)
	}
	p := dbmanage.Provisioner{Engine: engine, Linker: linker, ModuleRoots: c.ModuleRoot, Environment: "production"}
	return p.Provision(ctx, app.DB, nil)
}
