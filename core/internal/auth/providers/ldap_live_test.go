package providers

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"
)

func TestLDAPDirectoryLive(t *testing.T) {
	url := os.Getenv("LDAP_TEST_URL")
	if url == "" {
		t.Skip("LDAP_TEST_URL not set")
	}
	cfg := LLDAPDefaults(os.Getenv("LDAP_TEST_BASE_DN"))
	cfg.URL, cfg.BindDN, cfg.BindPassword = url, os.Getenv("LDAP_TEST_BIND_DN"), os.Getenv("LDAP_TEST_BIND_PASSWORD")
	d := LDAPDirectory{Timeout: 5 * time.Second}
	ctx := context.Background()
	if err := d.Check(ctx, cfg); err != nil {
		t.Fatalf("check: %v", err)
	}
	id, err := d.Authenticate(ctx, cfg, os.Getenv("LDAP_TEST_USER"), os.Getenv("LDAP_TEST_PASSWORD"))
	if err != nil || id.Subject == "" || id.Email == "" {
		t.Fatalf("authenticate = %+v, %v", id, err)
	}
	if _, err := d.Authenticate(ctx, cfg, os.Getenv("LDAP_TEST_USER"), "definitely-wrong"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("wrong password err = %v", err)
	}
}
