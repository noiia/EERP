package mcpoauth

import (
	"time"

	"core/orm/model"

	"github.com/google/uuid"
)

// Client is a dynamically registered client (RFC 7591). A CIMD client has no row:
// its metadata is read from its client_id URL. Not tenant-scoped: registration is
// anonymous and grants nothing until a user approves it.
type Client struct {
	model.BaseModel
	ClientID string `db:"client_id,index"`
	Name     string `db:"name"`
	// RedirectURIs is a JSON array of exact URIs.
	RedirectURIs string `db:"redirect_uris"`
}

// Code is an authorization code: stored hashed, single use, short lived.
type Code struct {
	model.BaseModel
	CodeHash    string     `db:"code_hash,index"`
	TenantID    uuid.UUID  `db:"tenant_id"`
	UserID      uuid.UUID  `db:"user_id"`
	ClientID    string     `db:"client_id"`
	ClientName  string     `db:"client_name"`
	RedirectURI string     `db:"redirect_uri"`
	Challenge   string     `db:"code_challenge"`
	ExpiresAt   time.Time  `db:"expires_at"`
	UsedAt      *time.Time `db:"used_at"`
	// GrantID is the grant the code was exchanged for: a second exchange
	// (a stolen code) revokes it.
	GrantID *uuid.UUID `db:"grant_id"`
}

// Grant is one user's approval of one client: the refresh token's home. Revoking
// it (deleted_at) ends its refresh token and, through the gid claim, its access
// tokens at once.
type Grant struct {
	model.BaseModel
	TenantID   uuid.UUID `db:"tenant_id,index"`
	UserID     uuid.UUID `db:"user_id,index"`
	ClientID   string    `db:"client_id"`
	ClientName string    `db:"client_name"`
	// RefreshHash is sha256 of the current refresh token; PrevRefreshHash of the
	// one it replaced, so presenting a spent token is detected as theft.
	RefreshHash     string     `db:"refresh_hash,index"`
	PrevRefreshHash string     `db:"prev_refresh_hash,index"`
	ExpiresAt       time.Time  `db:"expires_at"`
	LastUsedAt      *time.Time `db:"last_used_at"`
}

// TableName pins each struct to its table, for the typed repositories (the
// module's orm.Register names the same tables).
func (Client) TableName() string { return "oauth_client" }
func (Code) TableName() string   { return "oauth_code" }
func (Grant) TableName() string  { return "oauth_grant" }
