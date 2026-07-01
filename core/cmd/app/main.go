package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"core/internal/auth"
	"core/internal/common"
	authmw "core/internal/middleware"
	"core/internal/module"
	"core/internal/types"
	_ "core/modules/all"
	"core/orm"
	ormserver "core/orm/server"

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

	// Relative paths in the config are anchored to the config file's directory, not
	// the process CWD. This keeps a single committed config portable across machines
	// and across the different working directories the app, tests, and the frontend
	// build run from. Absolute paths are left untouched.
	configDir := filepath.Dir(*configFilePtr)
	resolveConfigPath := func(p string) string {
		if p == "" || filepath.IsAbs(p) {
			return p
		}
		return filepath.Join(configDir, p)
	}
	configContent.ApiConfigPath = resolveConfigPath(configContent.ApiConfigPath)
	for i, root := range configContent.ModuleRoot {
		configContent.ModuleRoot[i] = resolveConfigPath(root)
	}

	// Refuse to start with an insecure signing key.
	if configContent.MasterPassword == "" || configContent.MasterPassword == "change-me-in-production" {
		common.Logger.Fatal("❌ master_key is empty or set to the insecure default — set a strong secret before starting")
	}

	// api.yaml now carries only cosmetic API-surface overrides; security-critical
	// exclusions live in code (WithExcludeFields / WithExcluded). Even so, if a path
	// is configured the file MUST load cleanly — a missing or malformed override file
	// is a misconfiguration, so we fail closed rather than silently drop overrides.
	if configContent.ApiConfigPath != "" {
		if err := orm.LoadAPIConfig(configContent.ApiConfigPath); err != nil {
			common.Logger.Fatal("❌ failed to load api config — refusing to start",
				zap.String("path", configContent.ApiConfigPath), zap.Error(err))
		}
	}

	dbLink := fmt.Sprintf("postgres://%s:%s@%s:%d/%s",
		configContent.DbUser, configContent.DbPassword,
		configContent.DbHost, configContent.DbPort, configContent.DbName)
	dbConf := orm.Config{
		DSN:      dbLink,
		MaxConns: configContent.MaxConns,
		MinConns: configContent.MinConns,
		Debug:    *debugPtr,
	}

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

	// DEV ONLY: seed an admin user so login works out of the box (gated by config).
	if configContent.SeedDevAdmin {
		if err := auth.SeedDevAdmin(context.Background(), app.DB); err != nil {
			common.Logger.Error("❌ seed dev admin failed", zap.Error(err))
		} else {
			common.Logger.Warn("⚠️  seeded DEV admin user", zap.String("email", auth.DevAdminEmail))
		}
	}

	// ── Auth layer ────────────────────────────────────────────────────────────
	tokenSvc := auth.NewTokenService(configContent)
	refreshStore := auth.NewRefreshStore(app.DB)
	userRepo := auth.NewUserRepository(app.DB)
	permRepo := auth.NewPermissionRepository(app.DB)
	authHandler := auth.NewHandler(userRepo, tokenSvc, refreshStore, permRepo)

	jwtMw := authmw.JWTMiddleware(tokenSvc)
	permMw := authmw.PermissionMiddleware(permRepo)

	// ── Build server ──────────────────────────────────────────────────────────
	// Bind on PublicAddress (e.g. 0.0.0.0); clients reach the API at BackendBaseURL
	// (BackendHost[:BackendPort]/api/BackendVersion) — that's what the frontend uses.
	srvCfg := ormserver.Config{
		Addr: fmt.Sprintf("%s:%d", configContent.PublicAddress, configContent.BackendPort),
	}
	srv := ormserver.New(app, srvCfg)
	common.Logger.Info("backend API base", zap.String("url", configContent.BackendBaseURL()))

	// Public auth routes — no JWT/permission middleware.
	authGroup := srv.Echo().Group("/api/v1/auth")
	authGroup.POST("/login", authHandler.Login)
	authGroup.POST("/refresh", authHandler.Refresh)
	authGroup.POST("/logout", authHandler.Logout)

	// Protected routes — JWT + permission middleware on the group.
	srv.RegisterRoutes(ormserver.BuildHandlers(app), nil, jwtMw, permMw)

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
