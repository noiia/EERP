package types

import (
	"strconv"
	"strings"
	"time"
)

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
		BackendHost:       "127.0.0.1",
		BackendVersion:    "v1",
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
	AccessTTLSeconds  int           `json:"access_ttl_seconds" needed:"false"`
	RefreshTTLSeconds int           `json:"refresh_ttl_seconds" needed:"false"`
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
	// BackendHost / BackendVersion describe how clients (e.g. the frontend BFF) reach
	// the API — distinct from PublicAddress, which is the bind address. The frontend
	// derives its API_BASE from BackendHost[:BackendPort] and API version from
	// BackendVersion.
	BackendHost    string `json:"backend_host" needed:"false"`
	BackendVersion string `json:"backend_version" needed:"false"`
	// AllowedOrigins is the CORS allow-list for browser clients. Leave empty only in
	// development — an empty list falls back to "*" (any origin). Set it to the
	// frontend origin(s) in production.
	AllowedOrigins []string `json:"allowed_origins" needed:"false"`
	// RequestBodyLimit caps request body size (e.g. "1M", "512K"). Defaults to "1M".
	RequestBodyLimit string `json:"request_body_limit" needed:"false"`
	// AuthRateLimitPerMinute throttles the public auth endpoints per client IP to
	// blunt credential brute-forcing. Defaults to 20/min when unset.
	AuthRateLimitPerMinute int `json:"auth_rate_limit_per_minute" needed:"false"`
	// SeedDevAdmin, when true, seeds a development admin user on startup so login works
	// out of the box. DEV ONLY — never enable in production.
	SeedDevAdmin bool `json:"seed_dev_admin" needed:"false"`
	// S3* configure the object store backing the picture service (Garage in dev —
	// infra/garage/README.md). All empty = no object storage: the picture endpoints
	// are simply not mounted. The endpoint carries an explicit scheme
	// (http://127.0.0.1:3910 on the host, http://garage:3900 in compose).
	S3Endpoint  string `json:"s3_endpoint" needed:"false"`
	S3Region    string `json:"s3_region" needed:"false"`
	S3Bucket    string `json:"s3_bucket" needed:"false"`
	S3AccessKey string `json:"s3_access_key" needed:"false"`
	S3SecretKey string `json:"s3_secret_key" needed:"false"`
	// PDFServiceURL and FrontendBaseURL configure PDF report generation
	// (docs/adr/ADR-010, docs/roadmaps/pdf-reports.md). Go normally has no
	// reason to reach the frontend — data flows the other way — but the
	// report pipeline must hand pdf-service a print URL to navigate to, so it
	// needs core-front's internal address. Both empty (or S3 unset) = report
	// generation is simply not mounted, same posture as the picture service.
	PDFServiceURL   string `json:"pdf_service_url" needed:"false"`
	FrontendBaseURL string `json:"frontend_base_url" needed:"false"`
	// NatsURL switches report rendering from a direct HTTP call to
	// pdf-service onto NATS request-reply (docs/roadmaps/pdf-reports.md
	// Phase 5) — N pdf-service replicas subscribed to the same queue group
	// become competing consumers for free. Optional: PDFServiceURL alone is
	// still a complete, valid setup; set this only once horizontal scaling
	// is an actual need, not by default.
	NatsURL string `json:"nats_url" needed:"false"`
	DSN     string
}

// BackendBaseURL builds the public API base URL clients use to reach the backend:
// {scheme}{host}[:{port}]/api/{version}. The host falls back to PublicAddress and the
// scheme defaults to http:// when absent. When BackendPort is 0 the port is omitted
// (host + version only); BackendVersion defaults to "v1".
func (c Config) BackendBaseURL() string {
	host := c.BackendHost
	if host == "" {
		host = c.PublicAddress
	}
	if !strings.HasPrefix(host, "http://") && !strings.HasPrefix(host, "https://") {
		host = "http://" + host
	}
	if c.BackendPort != 0 {
		host = host + ":" + strconv.Itoa(c.BackendPort)
	}
	version := c.BackendVersion
	if version == "" {
		version = "v1"
	}
	return host + "/api/" + version
}
