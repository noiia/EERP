package app

import (
	"net/http"
	"testing"

	"core/internal/auth"
	"core/internal/testdb"
	"core/internal/types"

	"github.com/google/uuid"
)

// Automated backups mount only with backup_dir, and only *:*:* (the dev
// admin) holds their permissions.
func TestApp_Backups(t *testing.T) {
	off := buildApp(t)
	if code, _ := off.do(http.MethodGet, "/api/v1/backups", nil); code != http.StatusNotFound {
		t.Errorf("without backup_dir: %d, want 404", code)
	}

	dir := t.TempDir()
	c := buildAppWith(t, func(cfg *types.Config) { cfg.BackupDir = dir })
	if code, body := c.do(http.MethodGet, "/api/v1/backups", nil); code != http.StatusOK {
		t.Fatalf("admin GET: %d %s", code, body)
	}
	if code, body := c.do(http.MethodGet, "/api/v1/backups/databases", nil); code != http.StatusOK {
		t.Errorf("admin databases: %d %s", code, body)
	}

	user := auth.Users{TenantID: auth.DevTenantID}
	user.ID = uuid.New()
	token, err := auth.NewTokenService(testdb.Config(t)).IssueAccess(user, []string{"app-test-nobody-" + uuid.NewString()}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	staff := &client{t: t, h: c.h, token: token}
	for _, r := range []struct{ method, path string }{
		{http.MethodGet, "/api/v1/backups"},
		{http.MethodPost, "/api/v1/backups/run"},
	} {
		if code, _ := staff.do(r.method, r.path, nil); code != http.StatusForbidden {
			t.Errorf("%s %s without permission: %d, want 403", r.method, r.path, code)
		}
	}
}
