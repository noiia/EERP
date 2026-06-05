package types

import (
	"os"
	"time"
)

// EnvOrDefault returns the env var for key, or fallback when unset or empty.
// Centralises all env-based overrides so callers never reimplement this pattern.
func (Config) EnvOrDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// DefaultConfig returns a *Config with every optional field pre-filled with a
// sensible development default.  Required fields (db credentials, module_root,
// passwords) are intentionally left as zero values — the caller must supply them.
// Use this as a starting point: marshal it to JSON with -generate-config, edit
// the required fields, and pass the result via -config.
func DefaultConfig() *Config {
	return &Config{
		DbPort:            5432,
		DbHost:            "localhost",
		DbUser:            "postgres",
		DbName:            "eerp",
		MaxConns:          10,
		MinConns:          2,
		PublicAddress:     "0.0.0.0",
		BackendPort:       8080,
		MaxConnIdleTime:   5 * time.Minute,
		MaxConnLifeTime:   30 * time.Minute,
		HealthCheckPeriod: time.Minute,
		ConnectTimeout:    10 * time.Second,
		ApiConfigPath:     "api.yaml",
		ModuleRoot:        []string{"modules"},
	}
}

// Config fields
type Config struct {
	ModuleRoot        []string      `json:"module_root" needed:"true"`
	MasterPassword    string        `json:"master_key" needed:"false"`
	ContainerPool     int           `json:"container_pool" needed:"false"`
	ThreadPool        int           `json:"thread_pool" needed:"false"`
	DbName            string        `json:"db_name" needed:"false"`
	DbPort            int           `json:"db_port" needed:"true"`
	DbHost            string        `json:"db_host" needed:"true"`
	DbUser            string        `json:"db_user" needed:"true"`
	DbPassword        string        `json:"db_password" needed:"true"`
	MaxConns          int32         `json:"max_connection" needed:"false"`
	MinConns          int32         `json:"min_connection" needed:"false"`
	MaxConnIdleTime   time.Duration `json:"max_conn_idle_time" needed:"false"`
	MaxConnLifeTime   time.Duration `json:"max_conn_life_time" needed:"false"`
	HealthCheckPeriod time.Duration `json:"health_check_period" needed:"false"`
	ConnectTimeout    time.Duration `json:"connect_timeout" needed:"false"`
	ApiConfigPath     string        `json:"api_config_path" needed:"false"`
	PublicAddress     string        `json:"public_address" needed:"true"`
	BackendPort       int           `json:"backend_port" needed:"true"`
	DSN               string
}
