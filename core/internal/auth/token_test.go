package auth_test

import (
	"testing"
	"time"

	"core/internal/auth"
	"core/internal/types"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

func testConfig() *types.Config {
	return &types.Config{
		MasterPassword:    "test-secret-key-32-bytes-minimum!",
		AccessTTLSeconds:  3600,
		RefreshTTLSeconds: 604800,
	}
}

func testUser() auth.Users {
	return auth.Users{
		TenantID: uuid.MustParse("00000000-0000-0000-0000-000000000001"),
	}
}

// ── TokenService.IssueAccess ──────────────────────────────────────────────────

func TestIssueAccess_ReturnsSigned(t *testing.T) {
	svc := auth.NewTokenService(testConfig())
	u := testUser()
	u.BaseModel.ID = uuid.MustParse("00000000-0000-0000-0000-000000000002")

	tok, err := svc.IssueAccess(u, []string{"admin"}, nil, []string{"*:*:*"})
	if err != nil {
		t.Fatalf("IssueAccess: %v", err)
	}
	if tok == "" {
		t.Error("got empty token")
	}
}

func TestIssueAccess_EmbedsPermissionsClaim(t *testing.T) {
	// The frontend session mirror reads this claim to gate UI (Create buttons,
	// <Can>); Go still authorizes server-side, but the claim must round-trip.
	svc := auth.NewTokenService(testConfig())
	u := testUser()
	u.BaseModel.ID = uuid.New()

	raw, err := svc.IssueAccess(u, []string{"admin"}, nil, []string{"crm:contacts:write", "users:users:read"})
	if err != nil {
		t.Fatalf("IssueAccess: %v", err)
	}
	claims, err := svc.ParseAccess(raw)
	if err != nil {
		t.Fatalf("ParseAccess: %v", err)
	}
	if len(claims.Permissions) != 2 || claims.Permissions[0] != "crm:contacts:write" {
		t.Errorf("permissions = %v, want the issued codes", claims.Permissions)
	}
}

func TestParseAccess_ValidToken_ReturnsRoles(t *testing.T) {
	svc := auth.NewTokenService(testConfig())
	u := testUser()
	u.BaseModel.ID = uuid.New()
	roles := []string{"admin", "crm:write"}

	raw, err := svc.IssueAccess(u, roles, nil, nil)
	if err != nil {
		t.Fatalf("IssueAccess: %v", err)
	}

	claims, err := svc.ParseAccess(raw)
	if err != nil {
		t.Fatalf("ParseAccess: %v", err)
	}
	if claims.Sub != u.ID {
		t.Errorf("sub = %v, want %v", claims.Sub, u.ID)
	}
	if claims.Tenant != u.TenantID {
		t.Errorf("tenant = %v, want %v", claims.Tenant, u.TenantID)
	}
	if len(claims.Roles) != 2 || claims.Roles[0] != "admin" {
		t.Errorf("roles = %v, want %v", claims.Roles, roles)
	}
}

func TestParseAccess_ExpiredToken_ReturnsError(t *testing.T) {
	cfg := testConfig()
	cfg.AccessTTLSeconds = -1 // already expired
	svc := auth.NewTokenService(cfg)
	u := testUser()
	u.BaseModel.ID = uuid.New()

	// Build a token that expired 1 second ago.
	claims := &auth.Claims{
		Sub:    u.ID,
		Tenant: u.TenantID,
		Roles:  nil,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   u.ID.String(),
			IssuedAt:  jwt.NewNumericDate(time.Now().Add(-2 * time.Hour)),
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(-1 * time.Hour)),
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	raw, _ := token.SignedString([]byte(cfg.MasterPassword))

	_, err := svc.ParseAccess(raw)
	if err == nil {
		t.Error("expected error for expired token")
	}
}

func TestParseAccess_WrongKey_ReturnsError(t *testing.T) {
	svc1 := auth.NewTokenService(testConfig())
	cfg2 := testConfig()
	cfg2.MasterPassword = "different-secret-key-32-bytes!!"
	svc2 := auth.NewTokenService(cfg2)

	u := testUser()
	u.BaseModel.ID = uuid.New()
	raw, _ := svc1.IssueAccess(u, nil, nil, nil)

	_, err := svc2.ParseAccess(raw)
	if err == nil {
		t.Error("expected error for token signed with different key")
	}
}

func TestParseAccess_MalformedToken_ReturnsError(t *testing.T) {
	svc := auth.NewTokenService(testConfig())
	_, err := svc.ParseAccess("not.a.jwt")
	if err == nil {
		t.Error("expected error for malformed token")
	}
}

// ── TokenService.IssueRefresh / ParseRefresh ──────────────────────────────────

func TestIssueRefresh_ParseRefresh_RoundTrip(t *testing.T) {
	svc := auth.NewTokenService(testConfig())
	userID := uuid.New()

	raw, err := svc.IssueRefresh(userID)
	if err != nil {
		t.Fatalf("IssueRefresh: %v", err)
	}

	got, err := svc.ParseRefresh(raw)
	if err != nil {
		t.Fatalf("ParseRefresh: %v", err)
	}
	if got != userID {
		t.Errorf("userID = %v, want %v", got, userID)
	}
}

func TestParseRefresh_InvalidToken_ReturnsError(t *testing.T) {
	svc := auth.NewTokenService(testConfig())
	_, err := svc.ParseRefresh("garbage")
	if err == nil {
		t.Error("expected error for invalid refresh token")
	}
}

// ── Default TTL fallback ──────────────────────────────────────────────────────

func TestTokenService_ZeroTTL_UsesDefaults(t *testing.T) {
	cfg := &types.Config{
		MasterPassword: "test-secret-key-32-bytes-minimum!",
		// zero TTL → defaults applied
	}
	svc := auth.NewTokenService(cfg)
	u := testUser()
	u.BaseModel.ID = uuid.New()

	tok, err := svc.IssueAccess(u, nil, nil, nil)
	if err != nil {
		t.Fatalf("IssueAccess with zero TTL: %v", err)
	}
	claims, err := svc.ParseAccess(tok)
	if err != nil {
		t.Fatalf("ParseAccess with zero TTL: %v", err)
	}
	if claims.Sub != u.ID {
		t.Errorf("sub mismatch")
	}
}
