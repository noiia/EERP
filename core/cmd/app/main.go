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
	"core/internal/notebook"
	"core/internal/pictures"
	"core/internal/reports"
	"core/internal/settings"
	"core/internal/types"
	_ "core/modules/all"
	"core/modules/crminheritdemo"
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
	linker := wasmtime.NewLinker(engine)

	if err := linker.DefineWasi(); err != nil {
		common.Logger.Fatal("❌ DefineWasi error", zap.Error(err))
	}
	if err := linker.FuncWrap("host", "log", func(ptr int32, len int32) {
		common.Logger.Info("📦 WASM LOG CALLED")
	}); err != nil {
		common.Logger.Fatal("❌ FuncWrap error", zap.Error(err))
	}

	// moduleRuntime replaces the old one-shot LoadModules/LoadGoModules pair:
	// it loads EVERY discovered module (WASM and Go, active or not) and keeps
	// enough live state (which module owns which table, and whether it's
	// currently active) to gate requests and flip modules on/off with no
	// restart — see internal/module/runtime.go.
	moduleRuntime := module.NewRegistry(engine, linker, app.DB, configContent.ModuleRoot)
	for _, err := range moduleRuntime.Boot(context.Background()) {
		common.Logger.Error("❌ Error loading module", zap.Error(err))
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
		Addr:         fmt.Sprintf("%s:%d", configContent.PublicAddress, configContent.BackendPort),
		AllowOrigins: configContent.AllowedOrigins,
		BodyLimit:    configContent.RequestBodyLimit,
	}
	if len(configContent.AllowedOrigins) == 0 {
		common.Logger.Warn("⚠️  allowed_origins not set — CORS defaults to \"*\"; set it to the frontend origin(s) in production")
	}
	srv := ormserver.New(app, srvCfg)
	common.Logger.Info("backend API base", zap.String("url", configContent.BackendBaseURL()))

	// Public auth routes — no JWT/permission middleware, but rate-limited per IP to
	// blunt credential brute-forcing.
	authGroup := srv.Echo().Group("/api/v1/auth", ormserver.AuthRateLimiter(configContent.AuthRateLimitPerMinute))
	authGroup.POST("/login", authHandler.Login)
	authGroup.POST("/refresh", authHandler.Refresh)
	authGroup.POST("/logout", authHandler.Logout)

	// ── Settings / preferences ────────────────────────────────────────────────
	settingsHandler := settings.NewHandler(userRepo, settings.NewRepository(app.DB))

	// Self-service routes: JWT only, no permission middleware. The identity in the
	// token scopes every query to the caller's own record, so granting a dedicated
	// permission would gate users out of their own preferences.
	meGroup := srv.Echo().Group("/api/v1/me", jwtMw)
	meGroup.GET("/preferences", settingsHandler.GetMyPreferences)
	meGroup.PUT("/preferences", settingsHandler.PutMyPreferences)

	// Tenant-wide settings: JWT + permission middleware (PUT /settings/i18n
	// derives settings:i18n:write, PUT /settings/format settings:format:write,
	// GET|PUT /settings/views/:entity/fields and .../graph settings:views:read|write
	// — the Kanban/Calendar field config and Graph tile layout from
	// docs/roadmaps/list-view-modes.md).
	settingsGroup := srv.Echo().Group("/api/v1/settings", jwtMw, permMw)
	settingsGroup.PUT("/i18n", settingsHandler.PutI18nSettings)
	settingsGroup.PUT("/format", settingsHandler.PutFormatSettings)
	settingsGroup.GET("/views/:entity/fields", settingsHandler.GetViewFieldsSettings)
	settingsGroup.PUT("/views/:entity/fields", settingsHandler.PutViewFieldsSettings)
	settingsGroup.GET("/views/:entity/graph", settingsHandler.GetGraphLayoutSettings)
	settingsGroup.PUT("/views/:entity/graph", settingsHandler.PutGraphLayoutSettings)
	settingsGroup.GET("/apps/:module/picture-size", settingsHandler.GetPictureSizeSettings)
	settingsGroup.PUT("/apps/:module/picture-size", settingsHandler.PutPictureSizeSettings)

	// ── Pictures ──────────────────────────────────────────────────────────────
	// Dedicated binary-content endpoints (the picture table is off the generic
	// CRUD surface). Mounted only when the config carries an object store —
	// without s3_* the feature is absent, not broken. The permission middleware
	// derives pictures:pictures:read|write|delete from the routes.
	if pictures.S3Configured(configContent) {
		objects, err := pictures.NewS3Store(configContent)
		if err != nil {
			common.Logger.Fatal("❌ Error building S3 object store", zap.Error(err))
		}
		picturesHandler := pictures.NewHandler(pictures.NewRepository(app.DB), objects)
		picturesGroup := srv.Echo().Group("/api/v1/pictures", jwtMw, permMw)
		picturesGroup.POST("", picturesHandler.Upload)
		picturesGroup.GET("", picturesHandler.Find)
		picturesGroup.GET("/:id", picturesHandler.Get)
		picturesGroup.DELETE("/:id", picturesHandler.Delete)
	} else {
		common.Logger.Warn("⚠️  s3_* not configured — picture endpoints disabled")
	}

	// ── Reports (PDF generation) ─────────────────────────────────────────────
	// Dedicated report-generation endpoints (docs/adr/ADR-010, docs/roadmaps/
	// pdf-reports.md) — mounted only when both an object store (s3_*, shared
	// with pictures) and pdf_service_url/frontend_base_url are configured;
	// absent either, the feature is simply not mounted, same posture as
	// pictures' own s3_* gate. GeneratePDF is deliberately NOT behind permMw
	// (see its own doc comment); DownloadPDF is, since it's a flat route.
	if pictures.S3Configured(configContent) && reports.Configured(configContent) {
		reportsObjects, err := pictures.NewS3Store(configContent)
		if err != nil {
			common.Logger.Fatal("❌ Error building S3 object store for reports", zap.Error(err))
		}
		reportsHandler := reports.NewHandler(
			reports.NewHTTPPDFRenderer(configContent.PDFServiceURL),
			reportsObjects,
			tokenSvc,
			permRepo,
			configContent.FrontendBaseURL,
		)
		reportsGroup := srv.Echo().Group("/api/v1/reports", jwtMw)
		reportsGroup.POST("/:name/:id/pdf", reportsHandler.GeneratePDF)
		reportsGroup.GET("/pdf", reportsHandler.DownloadPDF, permMw)
	} else {
		common.Logger.Warn("⚠️  s3_* / pdf_service_url / frontend_base_url not configured — report generation disabled")
	}

	// ── Notebook pages ────────────────────────────────────────────────────────
	// Runtime, per-record notebook pages (docs/roadmaps/responsive-displays.md,
	// Phase 5) — the third category ADR-007 names alongside descriptor structure
	// and workspace app_settings. Dedicated, tenant-pinned endpoints off the
	// generic CRUD surface, mirroring the picture service's shape minus the
	// object-storage leg (page content is text, stored in the row). No external
	// dependency to gate on, so — unlike pictures — this mounts unconditionally.
	// The permission middleware derives notebook_pages:notebook_pages:read|write|delete
	// from the route.
	notebookHandler := notebook.NewHandler(notebook.NewRepository(app.DB))
	notebookGroup := srv.Echo().Group("/api/v1/notebook_pages", jwtMw, permMw)
	notebookGroup.GET("", notebookHandler.List)
	notebookGroup.POST("", notebookHandler.Create)
	notebookGroup.PUT("/:id", notebookHandler.Update)
	notebookGroup.DELETE("/:id", notebookHandler.Delete)

	// ── Module management (App Store) ────────────────────────────────────────
	// Dedicated endpoints over module.json content plus the live runtime
	// registry (docs/roadmaps/app-store.md, docs/adr/ADR-008) — a virtual
	// entity, never tenant-scoped (modules are workspace-wide, not per-tenant
	// data). List/Get re-walk module_root on every call (no snapshot/cache);
	// PUT/reload act on moduleRuntime first (live, no restart) and only then
	// persist module.json. The permission middleware derives
	// modules:modules:read|write from the route.
	modulesHandler := module.NewHandler(module.NewManager(configContent.ModuleRoot), moduleRuntime)
	modulesGroup := srv.Echo().Group("/api/v1/modules", jwtMw, permMw)
	modulesGroup.GET("", modulesHandler.List)
	modulesGroup.GET("/:id", modulesHandler.Get)
	modulesGroup.PUT("/:id", modulesHandler.Update)
	modulesGroup.POST("/:id/reload", modulesHandler.Reload)
	modulesGroup.GET("/:id/logs", modulesHandler.Logs)

	// ── Users / roles administration ──────────────────────────────────────────
	// The auth tables are excluded from the generic CRUD surface; these dedicated,
	// field-whitelisting endpoints are the only HTTP path to them. The permission
	// middleware derives users:users:* and roles:roles:* from the routes.
	adminHandler := auth.NewAdminHandler(userRepo, auth.NewRoleRepository(app.DB))
	usersGroup := srv.Echo().Group("/api/v1/users", jwtMw, permMw)
	usersGroup.GET("", adminHandler.ListUsers)
	usersGroup.POST("", adminHandler.CreateUser)
	usersGroup.GET("/:id", adminHandler.GetUser)
	usersGroup.PUT("/:id", adminHandler.UpdateUser)
	rolesGroup := srv.Echo().Group("/api/v1/roles", jwtMw, permMw)
	rolesGroup.GET("", adminHandler.ListRoles)
	rolesGroup.POST("", adminHandler.CreateRole)
	rolesGroup.GET("/:id", adminHandler.GetRole)
	rolesGroup.PUT("/:id", adminHandler.UpdateRole)

	// Protected routes — JWT + permission middleware on the group, plus
	// moduleRuntime's active-gate: a table owned by a deactivated module 403s
	// here instead of ever reaching its generic CRUD handler. Every table this
	// group serves comes from registry.All() (module-contributed schema —
	// auth/pictures/notebook/settings are off this surface entirely), so one
	// gate at the group level covers exactly the routes that need it.
	srv.RegisterRoutes(ormserver.BuildHandlers(app), nil, jwtMw, permMw, moduleRuntime.ActiveGateMiddleware())

	// ── crminheritdemo: Create() override reference example ─────────────────
	// Mounted AFTER the generic block above so Echo's router keeps THIS
	// registration for POST /api/v1/crm — confirmed empirically, Echo takes
	// the last Add() for an identical method+path, it does not panic or
	// merge. GET/PUT/DELETE/restore on /api/v1/crm are untouched, still
	// served by the generic handler; only Create is overridden. See
	// modules/crminheritdemo/handler.go for the full explanation of why this
	// is a hand-mounted route rather than a "hook" — no such hook exists.
	crmInheritCreate := crminheritdemo.NewHandler(orm.MustRepo[crminheritdemo.CRM](app.DB))
	srv.Echo().POST("/api/v1/crm", crmInheritCreate.Create, jwtMw, permMw, moduleRuntime.ActiveGateMiddleware())

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
