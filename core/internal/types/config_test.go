package types

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"core/orm"
)

func TestConfig_BackendBaseURL(t *testing.T) {
	tests := []struct {
		name string
		cfg  Config
		want string
	}{
		{
			name: "host port and version",
			cfg:  Config{BackendHost: "127.0.0.1", BackendPort: 8080, BackendVersion: "v1"},
			want: "http://127.0.0.1:8080/api/v1",
		},
		{
			name: "empty port omits the port",
			cfg:  Config{BackendHost: "api.example.com", BackendVersion: "v2"},
			want: "http://api.example.com/api/v2",
		},
		{
			name: "explicit scheme is preserved",
			cfg:  Config{BackendHost: "https://api.example.com", BackendPort: 443, BackendVersion: "v1"},
			want: "https://api.example.com:443/api/v1",
		},
		{
			name: "falls back to public address and default version",
			cfg:  Config{PublicAddress: "0.0.0.0", BackendPort: 8080},
			want: "http://0.0.0.0:8080/api/v1",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.cfg.BackendBaseURL(); got != tt.want {
				t.Errorf("BackendBaseURL() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestConfig_DSN(t *testing.T) {
	tests := []struct {
		name string
		cfg  Config
		want string
	}{
		{"plain", Config{DbUser: "postgres", DbPassword: "pw", DbHost: "db", DbPort: 5432, DbName: "poc"},
			"postgres://postgres:pw@db:5432/poc"},
		{"special characters are escaped", Config{DbUser: "u", DbPassword: "p@ss/w:rd", DbHost: "localhost", DbPort: 5433, DbName: "x"},
			"postgres://u:p%40ss%2Fw%3Ard@localhost:5433/x"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.cfg.DSN(); got != tt.want {
				t.Errorf("DSN() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestConfig_ResolvePaths(t *testing.T) {
	tests := []struct {
		name string
		cfg  Config
		want Config
	}{
		{"relative paths anchor to the config dir; empty cron dir defaults",
			Config{ApiConfigPath: "api.yaml", ModuleRoot: []string{"core/modules"}},
			Config{ApiConfigPath: "/repo/api.yaml", ModuleRoot: []string{"/repo/core/modules"}, CronLogDir: "/repo/cron_logs"}},
		{"absolute and empty paths are left alone",
			Config{ApiConfigPath: "", ModuleRoot: []string{"/abs/modules"}, CronLogDir: "/var/log/cron"},
			Config{ApiConfigPath: "", ModuleRoot: []string{"/abs/modules"}, CronLogDir: "/var/log/cron"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tt.cfg.ResolvePaths("/repo")
			if !reflect.DeepEqual(tt.cfg, tt.want) {
				t.Errorf("got %+v, want %+v", tt.cfg, tt.want)
			}
		})
	}
}

func TestConfig_PoolConfig(t *testing.T) {
	tests := []struct {
		name string
		json string
		want orm.Config
	}{
		{
			name: "timings are seconds, as every shipped config writes them",
			json: `{"max_connection": 10, "min_connection": 4, "max_conn_idle_time": 1800,
				"max_conn_life_time": 3600, "health_check_period": 60, "connect_timeout": 10}`,
			want: orm.Config{DSN: "dsn", MaxConns: 10, MinConns: 4, MaxConnIdleTime: 30 * time.Minute,
				MaxConnLifeTime: time.Hour, HealthCheckPeriod: time.Minute, ConnectTimeout: 10 * time.Second},
		},
		{
			name: "absent keys stay zero so the pool applies its defaults",
			json: `{}`,
			want: orm.Config{DSN: "dsn"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var cfg Config
			if err := json.Unmarshal([]byte(tt.json), &cfg); err != nil {
				t.Fatal(err)
			}
			if got := cfg.PoolConfig("dsn"); got != tt.want {
				t.Errorf("PoolConfig() = %+v, want %+v", got, tt.want)
			}
		})
	}
}
