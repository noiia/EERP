package types

import "testing"

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
