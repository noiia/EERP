// cmd/server is the entry point for the schema-driven HTTP API server.
// Register structs here → routes appear at /api/v1/{table}.
package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"core/orm"
	ormserver "core/orm/server"

	"go.uber.org/zap"
)

func main() {
	logger, err := zap.NewProduction()
	if err != nil {
		panic(err)
	}
	defer logger.Sync() //nolint:errcheck

	// ── Load api.yaml overrides (optional) ───────────────────────────────────
	if path := envOrDefault("API_CONFIG", "api.yaml"); fileExists(path) {
		if err := orm.LoadAPIConfig(path); err != nil {
			logger.Warn("could not load api.yaml", zap.String("path", path), zap.Error(err))
		}
	}

	// ── Register structs ──────────────────────────────────────────────────────
	// Add Register[YourStruct]() calls here, e.g.:
	//
	//   orm.Register[crm.Contact](orm.WithReadOnlyFields("id", "created_at", "updated_at"))
	//
	// Re-run the server after adding a new struct — routes appear automatically.
	orm.AutoScan("") // no-op; kept for documentation symmetry

	// ── Open database ─────────────────────────────────────────────────────────
	cfg := orm.Config{
		DSN: requiredEnv(logger, "DATABASE_URL"),
	}

	app, err := orm.New(cfg, logger)
	if err != nil {
		logger.Fatal("failed to open database", zap.Error(err))
	}
	defer app.Close() //nolint:errcheck

	// ── Build server ──────────────────────────────────────────────────────────
	srvCfg := ormserver.Config{
		Addr: envOrDefault("HTTP_ADDR", ":8080"),
	}
	srv := ormserver.New(app, srvCfg)
	srv.RegisterRoutes(ormserver.BuildHandlers(app))

	// ── Graceful shutdown ─────────────────────────────────────────────────────
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	logger.Info("server starting", zap.String("addr", srvCfg.Addr))
	if err := srv.Start(ctx); err != nil {
		logger.Error("server stopped with error", zap.Error(err))
	}
}

func envOrDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func requiredEnv(logger *zap.Logger, key string) string {
	v := os.Getenv(key)
	if v == "" {
		logger.Fatal("required environment variable not set", zap.String("key", key))
	}
	return v
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
