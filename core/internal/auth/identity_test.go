package auth_test

import (
	"context"
	"testing"

	"core/internal/auth"

	"github.com/google/uuid"
)

func TestIdentityFromContext_Missing_ReturnsFalse(t *testing.T) {
	_, ok := auth.IdentityFromContext(context.Background())
	if ok {
		t.Error("expected false for empty context")
	}
}

func TestIdentityFromContext_Set_ReturnsIdentity(t *testing.T) {
	id := auth.Identity{
		UserID:   uuid.New(),
		TenantID: uuid.New(),
		Roles:    []string{"admin"},
	}
	ctx := auth.SetIdentity(context.Background(), id)

	got, ok := auth.IdentityFromContext(ctx)
	if !ok {
		t.Fatal("expected true after SetIdentity")
	}
	if got.UserID != id.UserID {
		t.Errorf("UserID = %v, want %v", got.UserID, id.UserID)
	}
	if got.TenantID != id.TenantID {
		t.Errorf("TenantID = %v, want %v", got.TenantID, id.TenantID)
	}
	if len(got.Roles) != 1 || got.Roles[0] != "admin" {
		t.Errorf("Roles = %v, want [admin]", got.Roles)
	}
}

func TestMustIdentity_Missing_Panics(t *testing.T) {
	defer func() {
		if r := recover(); r == nil {
			t.Error("expected panic when Identity is missing from context")
		}
	}()
	auth.MustIdentity(context.Background())
}

func TestMustIdentity_Present_ReturnsIdentity(t *testing.T) {
	id := auth.Identity{UserID: uuid.New()}
	ctx := auth.SetIdentity(context.Background(), id)
	got := auth.MustIdentity(ctx)
	if got.UserID != id.UserID {
		t.Errorf("UserID = %v, want %v", got.UserID, id.UserID)
	}
}

func TestNewIdentityFromClaims_MapsFields(t *testing.T) {
	cfg := testConfig()
	svc := auth.NewTokenService(cfg)
	u := testUser()
	u.BaseModel.ID = uuid.New()

	raw, _ := svc.IssueAccess(u, []string{"crm:read"})
	claims, _ := svc.ParseAccess(raw)

	id := auth.NewIdentityFromClaims(claims)
	if id.UserID != u.ID {
		t.Errorf("UserID = %v, want %v", id.UserID, u.ID)
	}
	if id.TenantID != u.TenantID {
		t.Errorf("TenantID = %v, want %v", id.TenantID, u.TenantID)
	}
	if len(id.Roles) != 1 || id.Roles[0] != "crm:read" {
		t.Errorf("Roles = %v, want [crm:read]", id.Roles)
	}
}
