package types

import (
	"reflect"
	"testing"
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
