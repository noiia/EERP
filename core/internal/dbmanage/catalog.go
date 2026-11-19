package dbmanage

import (
	"context"
	"fmt"
	"regexp"

	"core/internal/types"

	"github.com/jackc/pgx/v5"
)

// connInfo is the fixed part of every DSN this package builds — switching (or
// creating/dropping/dumping) a database only ever varies the database NAME,
// never the host/port/credentials (core/cmd/app/main.go builds its one boot
// DSN from exactly these same five fields).
type connInfo struct {
	Host     string
	Port     int
	User     string
	Password string
}

func (c connInfo) dsn(dbName string) string {
	return fmt.Sprintf("postgres://%s:%s@%s:%d/%s", c.User, c.Password, c.Host, c.Port, dbName)
}

// nameRe whitelists a database name to a safe Postgres identifier shape.
// CREATE/DROP DATABASE can't parameterize an identifier — this whitelist is
// what makes quoting it with pgx.Identifier{name}.Sanitize() safe below.
var nameRe = regexp.MustCompile(`^[a-z][a-z0-9_]{0,62}$`)

func validateName(name string) error {
	if !nameRe.MatchString(name) {
		return fmt.Errorf("database name must match %s", nameRe.String())
	}
	return nil
}

// DatabaseInfo is one row of the /database/management list. Status and
// everything after it are filled in by Handler.List from Manager's
// in-memory PrepareInfoFor (prepare.go) — ListDatabases itself only ever
// queries Postgres, so a caller that wants the merged view must go through
// the handler, not this function directly.
type DatabaseInfo struct {
	Name      string `json:"name"`
	SizeBytes int64  `json:"size_bytes"`
	Active    bool   `json:"active"`

	Status           PrepareStatus `json:"status"`
	PrepareError     string        `json:"prepare_error,omitempty"`
	ProgressDone     int           `json:"progress_done,omitempty"`
	ProgressTotal    int           `json:"progress_total,omitempty"`
	ElapsedSeconds   float64       `json:"elapsed_seconds,omitempty"`
	EstimatedSeconds float64       `json:"estimated_seconds,omitempty"`
}

// ListDatabases enumerates every EERP-shaped database on the server: every
// non-template, connectable database that carries the core "users" and
// "app_settings" tables (present in every deployment regardless of which
// business modules are compiled in) — this is what keeps `postgres`,
// `template0`/`template1`, and any unrelated database sharing this Postgres
// server out of the list entirely, with no separate exclusion list to
// maintain.
func ListDatabases(ctx context.Context, conn connInfo, activeName string) ([]DatabaseInfo, error) {
	maint, err := pgx.Connect(ctx, conn.dsn("postgres"))
	if err != nil {
		return nil, fmt.Errorf("dbmanage: connect to maintenance db: %w", err)
	}
	defer func() { _ = maint.Close(ctx) }()

	rows, err := maint.Query(ctx, `
		SELECT datname, pg_database_size(datname)
		FROM pg_database
		WHERE NOT datistemplate AND datallowconn
		ORDER BY datname`)
	if err != nil {
		return nil, fmt.Errorf("dbmanage: list pg_database: %w", err)
	}
	type candidate struct {
		name string
		size int64
	}
	var candidates []candidate
	for rows.Next() {
		var cand candidate
		if err := rows.Scan(&cand.name, &cand.size); err != nil {
			rows.Close()
			return nil, fmt.Errorf("dbmanage: scan pg_database: %w", err)
		}
		candidates = append(candidates, cand)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("dbmanage: iterate pg_database: %w", err)
	}

	var out []DatabaseInfo
	for _, cand := range candidates {
		if !isEERPShaped(ctx, conn, cand.name) {
			continue
		}
		out = append(out, DatabaseInfo{
			Name:      cand.name,
			SizeBytes: cand.size,
			Active:    cand.name == activeName,
		})
	}
	return out, nil
}

// isEERPShaped reports whether database name carries the two tables every
// EERP deployment has regardless of which business modules are compiled in.
// A connection failure (a database this role can't access, one mid-drop,
// etc.) is treated as "not EERP-shaped" rather than surfaced as a list-wide
// error — one unreachable database must not hide every other row.
func isEERPShaped(ctx context.Context, conn connInfo, dbName string) bool {
	c, err := pgx.Connect(ctx, conn.dsn(dbName))
	if err != nil {
		return false
	}
	defer func() { _ = c.Close(ctx) }()

	var ok bool
	err = c.QueryRow(ctx, `SELECT to_regclass('public.users') IS NOT NULL AND to_regclass('public.app_settings') IS NOT NULL`).Scan(&ok)
	return err == nil && ok
}

// CreateDatabase issues CREATE DATABASE over a maintenance connection. Schema
// provisioning (making it an actually-usable EERP database) is a separate
// step — see provision.go.
func CreateDatabase(ctx context.Context, conn connInfo, name string) error {
	if err := validateName(name); err != nil {
		return err
	}
	maint, err := pgx.Connect(ctx, conn.dsn("postgres"))
	if err != nil {
		return fmt.Errorf("dbmanage: connect to maintenance db: %w", err)
	}
	defer func() { _ = maint.Close(ctx) }()

	// #nosec G201 — name is whitelisted by validateName above; identifiers
	// can't be parameterized, so this is the standard safe pattern.
	sql := fmt.Sprintf("CREATE DATABASE %s", pgx.Identifier{name}.Sanitize())
	if _, err := maint.Exec(ctx, sql); err != nil {
		return fmt.Errorf("dbmanage: create database %s: %w", name, err)
	}
	return nil
}

// EnsureDatabaseExists creates cfg.DbName if it doesn't already exist on the
// configured server — core/cmd/app/main.go's own boot-time bootstrap step,
// called before it ever opens its real connection pool. Without this, a
// fresh deployment (or an existing one whose config gets pointed at a
// different, not-yet-provisioned db_name) fails to boot outright: Postgres
// refuses to connect to a database that doesn't exist at all. Schema
// provisioning is main.go's own subsequent module.Registry.Boot +
// auth.SeedDevAdmin call, exactly as for any other empty database — this
// function's only job is making sure that step has something to connect to.
// A database that already exists is left completely untouched, config and
// data alike.
func EnsureDatabaseExists(ctx context.Context, cfg *types.Config) error {
	conn := connInfo{Host: cfg.DbHost, Port: cfg.DbPort, User: cfg.DbUser, Password: cfg.DbPassword}
	maint, err := pgx.Connect(ctx, conn.dsn("postgres"))
	if err != nil {
		return fmt.Errorf("dbmanage: connect to maintenance db: %w", err)
	}
	defer func() { _ = maint.Close(ctx) }()

	var exists bool
	if err := maint.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1)`, cfg.DbName,
	).Scan(&exists); err != nil {
		return fmt.Errorf("dbmanage: check database %s exists: %w", cfg.DbName, err)
	}
	if exists {
		return nil
	}
	return CreateDatabase(ctx, conn, cfg.DbName)
}

// DropDatabase issues DROP DATABASE over a maintenance connection. Refuses
// up front (before even asking Postgres) when name is the currently active
// database — Postgres would likely refuse anyway (open connections), but a
// clear, purpose-built error here is better UX than a raw Postgres one on a
// page with no other context around it. Does NOT itself check for a
// prepared-but-not-active standby holding its own open connections on name —
// that's Manager.Delete's job (prepare.go), the only caller that should
// invoke this directly; a bare DropDatabase call against a prepared standby
// still fails the same way Postgres always would ("database is being
// accessed by other users").
func DropDatabase(ctx context.Context, conn connInfo, name, activeName string) error {
	if err := validateName(name); err != nil {
		return err
	}
	if name == activeName {
		return fmt.Errorf("cannot delete the currently active database")
	}
	maint, err := pgx.Connect(ctx, conn.dsn("postgres"))
	if err != nil {
		return fmt.Errorf("dbmanage: connect to maintenance db: %w", err)
	}
	defer func() { _ = maint.Close(ctx) }()

	// #nosec G201 — name is whitelisted by validateName above.
	sql := fmt.Sprintf("DROP DATABASE %s", pgx.Identifier{name}.Sanitize())
	if _, err := maint.Exec(ctx, sql); err != nil {
		return fmt.Errorf("dbmanage: drop database %s: %w", name, err)
	}
	return nil
}
