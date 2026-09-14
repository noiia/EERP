package orm

import (
	"context"

	"core/orm/log"
	"core/orm/pool/config"
	"core/orm/pool/db"

	"go.uber.org/zap"
)

// App bundles the database handle and logger — the sole entry point for cmd/server.
// Callers never import pool sub-packages directly.
type App struct {
	DB     *db.DB
	Logger *zap.Logger
	Config config.Config
}

// New opens the connection pool and returns a ready App.
// Uses context.Background internally so callers don't need to thread a context.
func New(cfg config.Config, logger *zap.Logger) (*App, error) {
	d, err := db.Open(context.Background(), cfg)
	if err != nil {
		return nil, err
	}
	d.SetLogger(log.NewZapLogger(logger))
	return &App{DB: d, Logger: logger, Config: cfg}, nil
}

// Close shuts down the connection pool. Call on application shutdown.
func (a *App) Close() error {
	a.DB.Close()
	return nil
}
