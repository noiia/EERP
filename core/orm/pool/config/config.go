package config

import (
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// Config holds all parameters needed to open the pgxpool connection.
type Config struct {
	// DSN is the full PostgreSQL connection string.
	// Example: "postgres://user:pass@localhost:5432/erp?sslmode=disable"
	DSN string

	// MaxConns is the maximum number of connections in the pool.
	// Defaults to 10 if zero.
	MaxConns int32

	// MinConns is the number of connections kept open at idle.
	// Defaults to 2 if zero.
	MinConns int32

	// MaxConnIdleTime is the maximum duration of an idle connection.
	// Defaults to 30 minutes.
	MaxConnIdleTime time.Duration

	// MaxConnLifeTime is the maximum duration of connections life time.
	// Defaults to 1 hour.
	MaxConnLifeTime time.Duration

	// HealthCheckPeriod is the maximum duration for db to return health check tests.
	// Defaults to 1 minute.
	HealthCheckPeriod time.Duration

	// ConnectTimeout is the maximum duration before connection is set as time out from the db.
	// Defaults to 10 seconds.
	ConnectTimeout time.Duration

	// Debug enables query logging at Debug level. When false,
	// only errors are logged regardless of the logger implementation.
	Debug bool

	ConnConfig *pgx.ConnConfig
}

// Validate returns an error if the Config is unusable.
func (c *Config) Validate() error {
	var errs []error

	if c.DSN == "" {
		errs = append(errs, errors.New("DSN must not be empty"))
	}

	if c.MaxConns < 0 {
		errs = append(errs, fmt.Errorf("MaxConns must be >= 0, got %d", c.MaxConns))
	}
	if c.MinConns < 0 {
		errs = append(errs, fmt.Errorf("MinConns must be >= 0, got %d", c.MinConns))
	}
	if c.MaxConns > 0 && c.MinConns > c.MaxConns {
		errs = append(errs, fmt.Errorf("MinConns (%d) must not exceed MaxConns (%d)", c.MinConns, c.MaxConns))
	}

	if c.MaxConnIdleTime < 0 {
		errs = append(errs, fmt.Errorf("MaxConnIdleTime must be >= 0, got %v", c.MaxConnIdleTime))
	}
	if c.MaxConnLifeTime < 0 {
		errs = append(errs, fmt.Errorf("MaxConnLifeTime must be >= 0, got %v", c.MaxConnLifeTime))
	}

	if c.HealthCheckPeriod < 0 {
		errs = append(errs, fmt.Errorf("HealthCheckPeriod must be >= 0, got %v", c.HealthCheckPeriod))
	}

	if c.ConnectTimeout < 0 {
		errs = append(errs, fmt.Errorf("ConnectTimeout must be >= 0, got %v", c.ConnectTimeout))
	}

	if err := c.withDefaults(); err != nil {
		errs = append(errs, fmt.Errorf("WithDefault error : %v", err))
	}

	return errors.Join(errs...)
}

// withDefaults returns a copy of c with zero values replaced by sensible defaults.
func (c *Config) withDefaults() error {
	if c.MaxConns == 0 {
		c.MaxConns = 10
	}
	if c.MinConns == 0 {
		c.MinConns = 2
	}

	if c.MaxConnIdleTime == 0 {
		c.MaxConnIdleTime = time.Minute * 30
	}

	if c.MaxConnLifeTime == 0 {
		c.MaxConnLifeTime = time.Hour
	}

	if c.HealthCheckPeriod == 0 {
		c.HealthCheckPeriod = time.Minute
	}

	if c.ConnConfig == nil {
		connConfig, err := pgx.ParseConfig(c.DSN)
		if err != nil {
			return err
		}
		c.ConnConfig = connConfig
	}

	if c.ConnectTimeout == 0 {
		c.ConnConfig.ConnectTimeout = time.Second * 10
	} else {
		c.ConnConfig.ConnectTimeout = c.ConnectTimeout
	}

	return nil
}
