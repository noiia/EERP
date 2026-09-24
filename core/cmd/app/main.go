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
	"time"

	"core/internal/attachments"
	"core/internal/auth"
	"core/internal/chatter"
	"core/internal/common"
	"core/internal/company"
	"core/internal/cron"
	"core/internal/graphfield"
	authmw "core/internal/middleware"
	"core/internal/module"
	"core/internal/notebook"
	"core/internal/pictures"
	"core/internal/presence"
	"core/internal/reports"
	"core/internal/savedfilter"
	"core/internal/settings"
	"core/internal/types"
	_ "core/modules/all"
	authmodule "core/modules/auth"
	"core/modules/crminheritdemo"
	cronmodule "core/modules/cron"
	"core/modules/propertymanagement"
	"core/modules/sale"
	"core/modules/warehouse"
	"core/orm"
	ormserver "core/orm/server"

	"github.com/bytecodealliance/wasmtime-go/v15"
	"github.com/nats-io/nats.go"
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
	if configContent.CronLogDir == "" {
		configContent.CronLogDir = "cron_logs"
	}
	configContent.CronLogDir = resolveConfigPath(configContent.CronLogDir)

	// Refuse to start with an insecure signing key. Named literals below are
	// values that have actually shipped as committed "defaults" in this repo's
	// history (docs/security/pentest-2026-09-24.md finding 1) — rejecting them
	// by name, not just by weak length, closes the exact hole a stale clone
	// would otherwise reopen.
	switch {
	case configContent.MasterPassword == "" || configContent.MasterPassword == "change-me-in-production":
		common.Logger.Fatal("❌ master_key is empty or set to the insecure default — set a strong secret in the config before starting")
	case configContent.MasterPassword == "ueioiehsiuehfs":
		common.Logger.Fatal("❌ master_key is set to a value previously committed to this repo's history — it must be treated as compromised; generate a new secret")
	case len(configContent.MasterPassword) < 32:
		common.Logger.Fatal("❌ master_key is too short to be a real signing secret (need 32+ bytes) — generate one with e.g. `openssl rand -base64 48`")
	}

	// Same posture for the DB credential — the ORM connects with whatever's
	// here, so a weak/default value is a straight DB compromise for anyone who
	// reaches the db port (see the pentest report's Finding 3).
	switch {
	case configContent.DbPassword == "" || configContent.DbPassword == "change-me-in-production":
		common.Logger.Fatal("❌ db_password is empty or set to the insecure default — set a strong secret in the config before starting")
	case configContent.DbPassword == "postgres":
		common.Logger.Fatal("❌ db_password is set to a value previously committed to this repo's history — it must be treated as compromised; generate a new secret")
	}

	// "environment" drives two behaviors (types.Config's own doc comment): demo
	// seeding only ever runs in development, and a freshly-seeded default admin
	// is only forced to change its password in production. No silent default —
	// an unset/misspelled value is exactly the kind of mistake that should fail
	// loud at boot rather than quietly landing on whichever behavior "".
	if configContent.Environment != "development" && configContent.Environment != "production" {
		common.Logger.Fatal(`❌ environment must be "development" or "production"`, zap.String("got", configContent.Environment))
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

	// Always seed the default admin so login works on a brand-new database, in every
	// mode — no config flag to miss. Idempotent (ON CONFLICT (id) DO NOTHING on a fixed
	// id): once the credential is changed through the app, re-running this on later
	// boots never overwrites it. In production this ALSO seeds the account with
	// must_change_password=true (SeedDevAdmin's own doc comment), which
	// PermissionMiddleware then enforces — the account exists and can log in, but
	// can't touch anything else until the password is changed, so "change it
	// immediately" is enforced instead of just requested. Development mode skips
	// that gate entirely (the same convenience seed_demo_data below assumes).
	if err := auth.SeedDevAdmin(context.Background(), app.DB, configContent.Environment); err != nil {
		common.Logger.Error("❌ seed default admin failed", zap.Error(err))
	} else {
		common.Logger.Warn("⚠️  default admin available — change its password immediately", zap.String("email", auth.DevAdminEmail))
	}

	// DEV ONLY: demo Property Management data (a property, its equipment/history,
	// a tenant, a generated rent receipt) so the module isn't empty out of the box.
	// Gated on environment now too (not just the flag) — a "production"-mode boot
	// never seeds fake data no matter how seed_demo_data is set.
	if configContent.Environment == "development" && configContent.SeedDemoData {
		if err := propertymanagement.SeedDemoData(context.Background(), app.DB); err != nil {
			common.Logger.Error("❌ seed property management demo data failed", zap.Error(err))
		} else {
			common.Logger.Warn("⚠️  seeded DEV property management demo data")
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
	companyRepo := company.NewRepository(app.DB)
	settingsHandler := settings.NewHandler(userRepo, settings.NewRepository(app.DB), companyRepo, configContent.Environment)

	// Self-service routes: JWT only, no permission middleware. The identity in the
	// token scopes every query to the caller's own record, so granting a dedicated
	// permission would gate users out of their own preferences.
	meGroup := srv.Echo().Group("/api/v1/me", jwtMw)
	meGroup.GET("/preferences", settingsHandler.GetMyPreferences)
	meGroup.PUT("/preferences", settingsHandler.PutMyPreferences)

	// Tenant-wide settings: JWT + permission middleware (PUT /settings/i18n
	// derives settings:i18n:write, PUT /settings/format settings:format:write,
	// GET|PUT /settings/views/:entity/fields, .../graph, and .../chatter all
	// derive settings:views:read|write — the Kanban/Calendar field config and
	// Graph tile layout from docs/roadmaps/list-view-modes.md, plus the form
	// chatter panel's visibility override (core-front/CLAUDE.md's "Form
	// chatter panel" row)).
	settingsGroup := srv.Echo().Group("/api/v1/settings", jwtMw, permMw)
	settingsGroup.PUT("/i18n", settingsHandler.PutI18nSettings)
	settingsGroup.PUT("/format", settingsHandler.PutFormatSettings)
	settingsGroup.GET("/views/:entity/fields", settingsHandler.GetViewFieldsSettings)
	settingsGroup.PUT("/views/:entity/fields", settingsHandler.PutViewFieldsSettings)
	settingsGroup.GET("/views/:entity/graph", settingsHandler.GetGraphLayoutSettings)
	settingsGroup.PUT("/views/:entity/graph", settingsHandler.PutGraphLayoutSettings)
	settingsGroup.GET("/views/:entity/chatter", settingsHandler.GetChatterSettings)
	settingsGroup.PUT("/views/:entity/chatter", settingsHandler.PutChatterSettings)
	settingsGroup.GET("/apps/:module/picture-size", settingsHandler.GetPictureSizeSettings)
	settingsGroup.PUT("/apps/:module/picture-size", settingsHandler.PutPictureSizeSettings)
	settingsGroup.GET("/reports/layout", settingsHandler.GetReportsLayoutSettings)
	settingsGroup.PUT("/reports/layout", settingsHandler.PutReportsLayoutSettings)
	settingsGroup.GET("/integrations/osm", settingsHandler.GetOSMSettings)
	settingsGroup.PUT("/integrations/osm", settingsHandler.PutOSMSettings)
	settingsGroup.GET("/tax", settingsHandler.GetTaxSettings)
	settingsGroup.PUT("/tax", settingsHandler.PutTaxSettings)
	settingsGroup.GET("/units", settingsHandler.GetUnitSettings)
	settingsGroup.PUT("/units", settingsHandler.PutUnitSettings)
	settingsGroup.GET("/accounts", settingsHandler.GetAccountsSettings)
	settingsGroup.PUT("/accounts", settingsHandler.PutAccountsSettings)

	// Company (multi-company): POST /company/:id/clone-settings copies every
	// setting from company :id (the source) to target_company_id — a new
	// company's create flow calls this once, right after creating the row,
	// before switching into it. Permission derives to company:company:write
	// from the route shape — the same permission creating a company itself
	// needs, no custom check required.
	companyGroup := srv.Echo().Group("/api/v1/company", jwtMw, permMw)
	companyGroup.POST("/:id/clone-settings", settingsHandler.CloneCompanySettings)

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

	// ── Attachments ───────────────────────────────────────────────────────────
	// Dedicated arbitrary-file endpoints (internal/attachments — the non-image
	// sibling of pictures above: boolean/file fields, e.g. property_management's
	// "billing of buy" and rent-receipt PDFs). Same S3 config/gate as pictures
	// (a second pictures.NewS3Store call, its own client instance — the object
	// store layer is provider-agnostic, reused verbatim rather than duplicated).
	// The permission middleware derives attachments:attachments:read|write|delete
	// from the routes.
	if pictures.S3Configured(configContent) {
		attachmentObjects, err := pictures.NewS3Store(configContent)
		if err != nil {
			common.Logger.Fatal("❌ Error building S3 object store for attachments", zap.Error(err))
		}
		attachmentsHandler := attachments.NewHandler(attachments.NewRepository(app.DB), attachmentObjects)
		attachmentsGroup := srv.Echo().Group("/api/v1/attachments", jwtMw, permMw)
		attachmentsGroup.POST("", attachmentsHandler.Upload)
		attachmentsGroup.GET("", attachmentsHandler.Find)
		attachmentsGroup.GET("/:id", attachmentsHandler.Get)
		attachmentsGroup.DELETE("/:id", attachmentsHandler.Delete)
	} else {
		common.Logger.Warn("⚠️  s3_* not configured — attachment endpoints disabled")
	}

	// ── Reports (PDF generation) ─────────────────────────────────────────────
	// Dedicated report-generation endpoints (docs/adr/ADR-010, docs/roadmaps/
	// pdf-reports.md) — mounted only when both an object store (s3_*, shared
	// with pictures) and a way to reach a renderer (pdf_service_url or
	// nats_url, Phase 5) plus frontend_base_url are configured; absent
	// either, the feature is simply not mounted, same posture as pictures'
	// own s3_* gate. GeneratePDF is deliberately NOT behind permMw (see its
	// own doc comment); DownloadPDF is, since it's a flat route.
	if pictures.S3Configured(configContent) && reports.Configured(configContent) {
		reportsObjects, err := pictures.NewS3Store(configContent)
		if err != nil {
			common.Logger.Fatal("❌ Error building S3 object store for reports", zap.Error(err))
		}

		// NATS wins if BOTH are set — nats_url is only ever set deliberately
		// (to actually get multi-worker scaling), so it names real intent;
		// pdf_service_url stays the zero-extra-infra default otherwise.
		var pdfRenderer reports.PDFRenderer
		if configContent.NatsURL != "" {
			// RetryOnFailedConnect: a transient NATS outage at boot (e.g. the
			// nats container is still starting) must not crash the whole API
			// server for a feature that's supposed to degrade gracefully like
			// every other reports dependency — Connect returns immediately,
			// reconnecting in the background; a render attempted before the
			// first successful connect just fails that one request (502).
			nc, err := nats.Connect(configContent.NatsURL,
				nats.RetryOnFailedConnect(true),
				nats.MaxReconnects(-1),
			)
			if err != nil {
				common.Logger.Fatal("❌ Error connecting to NATS for reports", zap.Error(err))
			}
			pdfRenderer = reports.NewNATSPDFRenderer(nc, 25*time.Second)
			common.Logger.Info("reports: rendering via NATS", zap.String("nats_url", configContent.NatsURL))
		} else {
			pdfRenderer = reports.NewHTTPPDFRenderer(configContent.PDFServiceURL)
		}

		reportsHandler := reports.NewHandler(
			pdfRenderer,
			reportsObjects,
			tokenSvc,
			permRepo,
			configContent.FrontendBaseURL,
		)
		reportsGroup := srv.Echo().Group("/api/v1/reports", jwtMw)
		reportsGroup.POST("/:name/:id/pdf", reportsHandler.GeneratePDF)
		reportsGroup.GET("/pdf", reportsHandler.DownloadPDF, permMw)
	} else {
		common.Logger.Warn("⚠️  s3_* / pdf_service_url|nats_url / frontend_base_url not configured — report generation disabled")
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

	// ── Saved filters ─────────────────────────────────────────────────────────
	// Named search-bar filter combinations (docs/adr/ADR-014-search-filter-bar.md),
	// private or shared per row. Dedicated, tenant-pinned endpoints off the
	// generic CRUD surface — "private OR shared" visibility and the owner-only
	// rename/delete check can't be expressed by a bare column-whitelist handler.
	// The permission middleware derives saved_filters:saved_filters:read|write|delete
	// from the route (a flat route with no literal second segment, so this is
	// safe — see the ADR for the /distinct query-param decision this mirrors).
	savedFilterHandler := savedfilter.NewHandler(savedfilter.NewRepository(app.DB))
	savedFilterGroup := srv.Echo().Group("/api/v1/saved_filters", jwtMw, permMw)
	savedFilterGroup.GET("", savedFilterHandler.List)
	savedFilterGroup.POST("", savedFilterHandler.Create)
	savedFilterGroup.PUT("/:id", savedFilterHandler.Update)
	savedFilterGroup.DELETE("/:id", savedFilterHandler.Delete)

	// ── Graph calculated fields ───────────────────────────────────────────────
	// Chart-only formula fields created from the Graph view, role-gated per row.
	// Dedicated tenant-pinned endpoints; permissions graph_fields:graph_fields:*
	// derive from the route. DELETE is a real hard delete.
	graphFieldHandler := graphfield.NewHandler(graphfield.NewRepository(app.DB))
	graphFieldGroup := srv.Echo().Group("/api/v1/graph_fields", jwtMw, permMw)
	graphFieldGroup.GET("", graphFieldHandler.List)
	graphFieldGroup.POST("", graphFieldHandler.Create)
	graphFieldGroup.PUT("/:id", graphFieldHandler.Update)
	graphFieldGroup.DELETE("/:id", graphFieldHandler.Delete)

	// ── Chatter ───────────────────────────────────────────────────────────────
	// A record's activity feed: user-authored messages plus the frontend's own
	// summary of a form edit, both posted the same way (Kind "message"/"log") —
	// dedicated, tenant-pinned endpoints off the generic CRUD surface, mirroring
	// the notebook pages' shape. Append-only (no PUT/DELETE — an activity log
	// reads wrong if entries can change after the fact). No external dependency
	// to gate on, so this mounts unconditionally. The permission middleware
	// derives chatter_messages:chatter_messages:read|write from the route.
	chatterHandler := chatter.NewHandler(chatter.NewRepository(app.DB), userRepo)
	chatterGroup := srv.Echo().Group("/api/v1/chatter_messages", jwtMw, permMw)
	chatterGroup.GET("", chatterHandler.List)
	chatterGroup.POST("", chatterHandler.Create)

	// ── Presence ──────────────────────────────────────────────────────────────
	// Live user status (online/absent/offline/busy/do_not_disturb) over a
	// WebSocket, docs/adr/ADR-019-user-presence-websocket.md. A native
	// WebSocket handshake can't carry a custom Authorization header, so this
	// group uses JWTOrCookieMiddleware instead of the plain jwtMw everywhere
	// else — it falls back to the SAME httpOnly session cookie the Next BFF
	// already sets (core-front's session-cookies.ts ACCESS_COOKIE, "eerp_access"
	// — the two sides can't share a literal across the language boundary, so
	// this is the single Go-side source of truth for that name) when there's
	// no Bearer header, which is only ever true for a same-origin browser
	// request. Every other route keeps requiring a real Bearer header. The
	// snapshot read and the WebSocket upgrade share ONE route (dispatched on
	// the Upgrade header inside Handler.Get). NOT behind permMw: presence is
	// app-shell chrome every authenticated user needs (the top-bar status
	// bubble, on every page), not gated business data, and PUT only ever
	// touches the caller's OWN row — there's no admin-only subset to protect
	// here the way modules' PUT/reload are. A role with zero role_permissions
	// grants (any freshly created custom role, admin_handler.go's CreateRole)
	// must still get this like every other identity.
	presenceHub := presence.NewHub()
	presenceHandler := presence.NewHandler(presence.NewRepository(app.DB), presenceHub)
	presenceAuthMw := authmw.JWTOrCookieMiddleware(tokenSvc, "eerp_access")
	presenceGroup := srv.Echo().Group("/api/v1/presence", presenceAuthMw)
	presenceGroup.GET("", presenceHandler.Get)
	presenceGroup.PUT("", presenceHandler.SetStatus)

	// ── Cron ──────────────────────────────────────────────────────────────────
	// Background scheduled actions (docs/adr/ADR-016-cron-scheduler.md). Unlike
	// chatter/notebook/savedfilter, cron/cron_history ride the GENERIC CRUD
	// surface (core/modules/cron/module.go's Register) — that's what gives
	// them List/Kanban/Calendar/Graph for free. Two hand-mounted additions on
	// top: Create/Update overrides on cron (resolving action_code from the
	// registry — mounted AFTER the generic block below so Echo keeps these
	// registrations, same posture as crminheritdemo/warehouse/sale) and one
	// extra action on cron_history (downloading a run's log file — a static
	// suffix after :id, so it derives the SAME cron_history:cron_history:read
	// permission the row's own GET already needs, no new wiring required).
	cron.SetEnv(app.DB, configContent.CronLogDir)
	cronOverride := cronmodule.NewHandler(orm.MustRepo[cron.Cron](app.DB))
	cronHistoryHandler := cron.NewHandler(cron.NewRepository(app.DB))
	cronHistoryGroup := srv.Echo().Group("/api/v1/cron_history", jwtMw, permMw, moduleRuntime.ActiveGateMiddleware())
	cronHistoryGroup.GET("/:id/log", cronHistoryHandler.DownloadLog)

	// ── Module management (App Store) ────────────────────────────────────────
	// Dedicated endpoints over module.json content plus the live runtime
	// registry (docs/roadmaps/app-store.md, docs/adr/ADR-008) — a virtual
	// entity, never tenant-scoped (modules are workspace-wide, not per-tenant
	// data). List/Get re-walk module_root on every call (no snapshot/cache);
	// PUT/reload act on moduleRuntime first (live, no restart) and only then
	// persist module.json. The permission middleware derives
	// modules:modules:read|write from the route for the admin-only actions
	// below. The bare list (GET "") is NOT behind permMw — every logged-in
	// user's app shell calls it unconditionally to build the top-bar module
	// menu (core-front's module-state.ts), so it needs to work for any
	// identity, including a custom role with zero role_permissions grants.
	modulesHandler := module.NewHandler(module.NewManager(configContent.ModuleRoot), moduleRuntime)
	modulesGroup := srv.Echo().Group("/api/v1/modules", jwtMw)
	modulesGroup.GET("", modulesHandler.List)
	modulesGroup.GET("/:id", modulesHandler.Get, permMw)
	modulesGroup.PUT("/:id", modulesHandler.Update, permMw)
	modulesGroup.POST("/:id/reload", modulesHandler.Reload, permMw)
	modulesGroup.GET("/:id/logs", modulesHandler.Logs, permMw)

	// The catalog of "views" (entities) a role's rights table can point at
	// (RoleViewPermission.Entity, a many2one in the frontend descriptor) —
	// read-only, computed live from core/orm's registry, so it always
	// reflects this deployment's compiled-in modules. The permission
	// middleware derives views:views:read from the route.
	viewsGroup := srv.Echo().Group("/api/v1/views", jwtMw, permMw)
	viewsGroup.GET("", settingsHandler.GetViewCatalog)

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

	// ── cron: Create/Update overrides ────────────────────────────────────────
	// Only these two verbs are overridden (GET/DELETE stay generic) — see the
	// "── Cron ──" section above for why. Mounted here, after the generic
	// block, for the same Echo route-registration-order reason crminheritdemo
	// is.
	srv.Echo().POST("/api/v1/cron", cronOverride.Create, jwtMw, permMw, moduleRuntime.ActiveGateMiddleware())
	srv.Echo().PUT("/api/v1/cron/:id", cronOverride.Update, jwtMw, permMw, moduleRuntime.ActiveGateMiddleware())

	// ── warehouse: product_variant Create override ───────────────────────────
	// Same reasoning as crminheritdemo above: only POST /api/v1/product_variant
	// is overridden (defaults Name from the underlying Product) — GET/PUT/DELETE
	// stay generic. See modules/warehouse/handler.go.
	productVariantCreate := warehouse.NewHandler(
		orm.MustRepo[warehouse.ProductVariant](app.DB),
		orm.MustRepo[warehouse.Product](app.DB),
	)
	srv.Echo().POST("/api/v1/product_variant", productVariantCreate.Create, jwtMw, permMw, moduleRuntime.ActiveGateMiddleware())

	// ── sale: sale_line Create/Update/Delete overrides ───────────────────────
	// Unlike crminheritdemo/warehouse above, THREE verbs are overridden here
	// (GET stays generic) — every mutation needs to resolve the line's variant
	// into a product-price/tax/unit snapshot and roll the invoice's totals back
	// up. See modules/sale/handler.go.
	saleLineHandler := sale.NewHandler(
		orm.MustRepo[sale.SaleLine](app.DB),
		orm.MustRepo[sale.Invoice](app.DB),
		orm.MustRepo[warehouse.ProductVariant](app.DB),
		orm.MustRepo[warehouse.Product](app.DB),
		orm.MustRepo[sale.SaleTax](app.DB),
		orm.MustRepo[sale.SaleLineTax](app.DB),
		settings.NewRepository(app.DB),
		companyRepo,
	)
	saleLineGroup := srv.Echo().Group("/api/v1/sale_line", jwtMw, permMw, moduleRuntime.ActiveGateMiddleware())
	saleLineGroup.POST("", saleLineHandler.Create)
	saleLineGroup.PUT("/:id", saleLineHandler.Update)
	saleLineGroup.DELETE("/:id", saleLineHandler.Delete)

	// ── sale: sale_line_tax Create/Delete overrides ──────────────────────────
	// Tagging/untagging a tax onto a sale_line recomputes that line's own
	// Total, then the invoice's rollup — GET stays generic. See
	// modules/sale/handler.go's CreateLineTax/DeleteLineTax.
	saleLineTaxGroup := srv.Echo().Group("/api/v1/sale_line_tax", jwtMw, permMw, moduleRuntime.ActiveGateMiddleware())
	saleLineTaxGroup.POST("", saleLineHandler.CreateLineTax)
	saleLineTaxGroup.DELETE("/:id", saleLineHandler.DeleteLineTax)

	// ── auth: role_view_permission[_right] Create/Update/Delete overrides ───
	// Wires the Rights UI (Settings → Users → Roles → a view's rights) into
	// REAL enforcement — see modules/auth/handler.go's RightsHandler doc
	// comment for why: RoleViewPermission was originally data-model-and-UI
	// only, never touching role_permissions (what PermissionRepository.Has
	// actually reads), so a freshly created custom role had no working way to
	// ever get real access to anything. Create is also overridden: a freshly
	// added view defaults to read+write+delete already tagged on (see
	// CreateViewPermission's own doc comment) instead of a blank row. GET/list
	// on both tables stay fully generic.
	rightsHandler := authmodule.NewRightsHandler(app.DB, permRepo)
	roleViewPermGroup := srv.Echo().Group("/api/v1/role_view_permission", jwtMw, permMw, moduleRuntime.ActiveGateMiddleware())
	roleViewPermGroup.POST("", rightsHandler.CreateViewPermission)
	roleViewPermGroup.PUT("/:id", rightsHandler.UpdateViewPermission)
	roleViewPermGroup.DELETE("/:id", rightsHandler.DeleteViewPermission)
	roleViewPermRightGroup := srv.Echo().Group("/api/v1/role_view_permission_right", jwtMw, permMw, moduleRuntime.ActiveGateMiddleware())
	roleViewPermRightGroup.POST("", rightsHandler.CreateRight)
	roleViewPermRightGroup.DELETE("/:id", rightsHandler.DeleteRight)

	// ── sale: quote_line Create/Update/Delete overrides ──────────────────────
	// Same reasoning as sale_line above, scoped to Quote/QuoteLine instead of
	// Invoice/SaleLine. See modules/sale/quote_handler.go.
	quoteLineHandler := sale.NewQuoteHandler(
		orm.MustRepo[sale.QuoteLine](app.DB),
		orm.MustRepo[sale.Quote](app.DB),
		orm.MustRepo[warehouse.ProductVariant](app.DB),
		orm.MustRepo[warehouse.Product](app.DB),
	)
	quoteLineGroup := srv.Echo().Group("/api/v1/quote_line", jwtMw, permMw, moduleRuntime.ActiveGateMiddleware())
	quoteLineGroup.POST("", quoteLineHandler.Create)
	quoteLineGroup.PUT("/:id", quoteLineHandler.Update)
	quoteLineGroup.DELETE("/:id", quoteLineHandler.Delete)

	// ── propertymanagement: property_management GET + equipment-status
	// Create + rent-receipt Delete override ──────────────────────────────────
	// property_management/property_management_equipment/... ride the generic
	// CRUD surface (module.go's Register, no WithExcluded) — same posture as
	// cron — with three hand-mounted overrides: GET on property_management
	// injects the computed receipt_generated_this_month key the "Generate
	// Rent Receipt" header button reads; POST on
	// property_management_equipment_status rolls the entry's State up onto
	// its parent Equipment's CurrentState; DELETE on
	// property_management_rent_receipt always rejects (a receipt row is
	// never removed — see RejectReceiptDelete). PUT stays generic: every
	// snapshot field on a receipt is meant to stay editable after the fact.
	// See modules/propertymanagement/handler.go.
	propertyManagementHandler := propertymanagement.NewHandler(
		orm.MustRepo[propertymanagement.PropertyManagement](app.DB),
		orm.MustRepo[propertymanagement.PropertyManagementEquipment](app.DB),
		orm.MustRepo[propertymanagement.PropertyManagementEquipmentStatus](app.DB),
		orm.MustRepo[propertymanagement.PropertyManagementBillingLine](app.DB),
		orm.MustRepo[propertymanagement.PropertyManagementBillingLineTax](app.DB),
		orm.MustRepo[sale.SaleTax](app.DB),
		orm.MustRepo[propertymanagement.PropertyManagementRentReceipt](app.DB),
		orm.MustRepo[propertymanagement.PropertyManagementRentReceiptLine](app.DB),
		orm.MustRepo[warehouse.ProductUoms](app.DB),
		settings.NewRepository(app.DB),
		companyRepo,
	)
	// POST overridden to default uom_id from the workspace's units.system
	// setting when the client didn't pick one (handler.go's CreateProperty);
	// GET overridden to inject the computed receipt_generated_this_month key.
	srv.Echo().POST("/api/v1/property_management", propertyManagementHandler.CreateProperty, jwtMw, permMw, moduleRuntime.ActiveGateMiddleware())
	srv.Echo().GET("/api/v1/property_management/:id", propertyManagementHandler.GetProperty, jwtMw, permMw, moduleRuntime.ActiveGateMiddleware())
	srv.Echo().POST("/api/v1/property_management_equipment_status", propertyManagementHandler.CreateEquipmentStatus, jwtMw, permMw, moduleRuntime.ActiveGateMiddleware())
	srv.Echo().DELETE("/api/v1/property_management_rent_receipt/:id", propertyManagementHandler.RejectReceiptDelete, jwtMw, permMw, moduleRuntime.ActiveGateMiddleware())
	srv.Echo().POST("/api/v1/property_management_rent_receipt_line", propertyManagementHandler.CreateRentReceiptLine, jwtMw, permMw, moduleRuntime.ActiveGateMiddleware())

	// ── propertymanagement: billing_line Create/Update + billing_line_tax
	// Create/Delete overrides ──────────────────────────────────────────────
	// Same "compute Total on line/tax changes" shape as sale_line/
	// sale_line_tax above, scoped to PropertyManagementBillingLine (GET/
	// DELETE stay generic). See modules/propertymanagement/handler.go.
	billingLineGroup := srv.Echo().Group("/api/v1/property_management_billing_line", jwtMw, permMw, moduleRuntime.ActiveGateMiddleware())
	billingLineGroup.POST("", propertyManagementHandler.CreateBillingLine)
	billingLineGroup.PUT("/:id", propertyManagementHandler.UpdateBillingLine)
	billingLineTaxGroup := srv.Echo().Group("/api/v1/property_management_billing_line_tax", jwtMw, permMw, moduleRuntime.ActiveGateMiddleware())
	billingLineTaxGroup.POST("", propertyManagementHandler.CreateBillingLineTax)
	billingLineTaxGroup.DELETE("/:id", propertyManagementHandler.DeleteBillingLineTax)

	for _, r := range srv.Routes() {
		common.Logger.Info("route", zap.String("method", r.Method), zap.String("path", r.Path))
	}

	// ── Graceful shutdown ─────────────────────────────────────────────────────
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	// The cron scheduler polls for due crons every minute until ctx is
	// canceled (see internal/cron/scheduler.go) — started here, alongside
	// the server, so it stops on the same SIGINT/SIGTERM.
	cronScheduler := cron.NewScheduler(app.DB, userRepo, permRepo, chatter.NewRepository(app.DB), configContent.CronLogDir)
	go cronScheduler.Run(ctx)

	// Quote expiry sweep (modules/sale/expiry.go): "if the valid until date
	// is reached, the quote's status goes to expired" is unconditional
	// business logic, not a user-configured scheduled action — a separate,
	// simpler ticker from the cron scheduler above, hourly since expiry
	// doesn't need minute-level precision. Runs once immediately so a quote
	// already overdue at boot doesn't wait a full hour for its first check.
	quoteRepo := orm.MustRepo[sale.Quote](app.DB)
	go func() {
		if err := sale.ExpireOverdueQuotes(ctx, quoteRepo); err != nil {
			common.Logger.Warn("sale: expire overdue quotes", zap.Error(err))
		}
		ticker := time.NewTicker(time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := sale.ExpireOverdueQuotes(ctx, quoteRepo); err != nil {
					common.Logger.Warn("sale: expire overdue quotes", zap.Error(err))
				}
			}
		}
	}()

	// Presence absent -> offline sweep (internal/presence/sweeper.go): every
	// minute, push the status of any user who's been disconnected past
	// absentAfter — nothing else triggers that transition, since no request
	// happens at the exact moment the 30 minutes elapse. Same inline-ticker
	// shape as the quote-expiry sweep above, since it's a single fixed job
	// too (unlike the cron scheduler, which manages many user-defined rows).
	presenceRepo := presence.NewRepository(app.DB)
	go func() {
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := presence.SweepAbsentToOffline(ctx, presenceRepo, presenceHub); err != nil {
					common.Logger.Warn("presence: sweep absent to offline", zap.Error(err))
				}
			}
		}
	}()

	common.Logger.Info("server starting", zap.String("addr", srvCfg.Addr))
	if err := srv.Start(ctx); err != nil {
		common.Logger.Error("server stopped with error", zap.Error(err))
	}
}
