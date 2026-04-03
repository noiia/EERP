package config

import (
	"errors"
	"fmt"
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

	// Debug enables query logging at Debug level. When false,
	// only errors are logged regardless of the logger implementation.
	Debug bool
}

// Validate returns an error if the Config is unusable.
func (c Config) Validate() error {
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

	c.withDefaults()

	return errors.Join(errs...)
}

// withDefaults returns a copy of c with zero values replaced by sensible defaults.
func (c Config) withDefaults() Config {
	if c.MaxConns == 0 {
		c.MaxConns = 10
	}
	if c.MinConns == 0 {
		c.MinConns = 2
	}
	return c
}
