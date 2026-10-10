// core/internal/auth/providers/provision_test.go
package providers_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	_ "core/modules/auth"

	"core/internal/auth/providers"
	"core/internal/testdb"
	"core/orm"

	"github.com/google/uuid"
)

type fixture struct {
	t      *testing.T
	db     *orm.DB
	tenant uuid.UUID
	admin  uuid.UUID // role id
	staff  uuid.UUID
}

func newFixture(t *testing.T) *fixture {
	app := testdb.Open(t)
	testdb.MigrateModules(t, app, "auth")
	f := &fixture{t: t, db: app.DB, tenant: uuid.New()}
	ctx := context.Background()
	for _, r := range []struct {
		name string
		id   *uuid.UUID
	}{{"ext-admin", &f.admin}, {"ext-staff", &f.staff}} {
		*r.id = uuid.New()
		if _, err := f.db.Exec(ctx, `INSERT INTO roles (id, tenant_id, name, description) VALUES ($1, $2, $3, '')`, *r.id, f.tenant, r.name+"-"+f.tenant.String()[:8]); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		for _, q := range []string{
			`DELETE FROM auth_identity WHERE tenant_id = $1`,
			`DELETE FROM user_roles WHERE tenant_id = $1`,
			`DELETE FROM users WHERE tenant_id = $1`,
			`DELETE FROM roles WHERE tenant_id = $1`,
		} {
			_, _ = f.db.Exec(ctx, q, f.tenant)
		}
	})
	return f
}

func (f *fixture) user(email string, deleted bool) uuid.UUID {
	id := uuid.New()
	q := `INSERT INTO users (id, tenant_id, email, password_hash, kind) VALUES ($1, $2, $3, 'x', '')`
	if deleted {
		q = `INSERT INTO users (id, tenant_id, email, password_hash, kind, deleted_at) VALUES ($1, $2, $3, 'x', '', now())`
	}
	if _, err := f.db.Exec(context.Background(), q, id, f.tenant, email); err != nil {
		f.t.Fatal(err)
	}
	return id
}

func (f *fixture) roles(user uuid.UUID) map[uuid.UUID]bool {
	rows, err := f.db.Query(context.Background(), `SELECT role_id FROM user_roles WHERE user_id = $1 AND deleted_at IS NULL`, user)
	if err != nil {
		f.t.Fatal(err)
	}
	defer rows.Close()
	out := map[uuid.UUID]bool{}
	for rows.Next() {
		var id uuid.UUID
		_ = rows.Scan(&id)
		out[id] = true
	}
	return out
}

func (f *fixture) methods() providers.Methods {
	return providers.Methods{RoleMapping: []providers.RoleMapping{
		{Group: "erp-admins", RoleID: f.admin}, {Group: "erp-staff", RoleID: f.staff},
	}}
}

func TestProvision(t *testing.T) {
	ctx := context.Background()
	f := newFixture(t)
	m := f.methods()
	email := func() string { return uuid.NewString()[:8] + "@ext.test" }

	t.Run("creates and links a new user with mapped roles", func(t *testing.T) {
		e := email()
		id, err := providers.NewProvisioner(f.db).Provision(ctx, f.tenant, providers.ExternalIdentity{
			Provider: "ldap", Subject: "uid=a," + e, Email: e, EmailVerified: true, DisplayName: "A", Groups: []string{"erp-staff"},
		}, m)
		if err != nil {
			t.Fatal(err)
		}
		if got := f.roles(id); len(got) != 1 || !got[f.staff] {
			t.Errorf("roles = %v", got)
		}
		again, err := providers.NewProvisioner(f.db).Provision(ctx, f.tenant, providers.ExternalIdentity{
			Provider: "ldap", Subject: "uid=a," + e, Email: "changed-" + e, EmailVerified: true, Groups: []string{"erp-admins"},
		}, m)
		if err != nil || again != id {
			t.Fatalf("second login = %v, %v; want the same user", again, err)
		}
		if got := f.roles(id); len(got) != 1 || !got[f.admin] {
			t.Errorf("roles after regroup = %v, want exactly admin", got)
		}
	})

	t.Run("links an existing user by verified email", func(t *testing.T) {
		e := email()
		existing := f.user(e, false)
		id, err := providers.NewProvisioner(f.db).Provision(ctx, f.tenant, providers.ExternalIdentity{
			Provider: "oidc:corp", Subject: "sub-1-" + e, Email: strings.ToUpper(e), EmailVerified: true, Groups: []string{"erp-staff"},
		}, m)
		if err != nil || id != existing {
			t.Fatalf("got %v, %v; want existing %v", id, err, existing)
		}
	})

	t.Run("an unverified email never links nor creates (Review Focus 2)", func(t *testing.T) {
		e := email()
		f.user(e, false)
		_, err := providers.NewProvisioner(f.db).Provision(ctx, f.tenant, providers.ExternalIdentity{
			Provider: "oidc:corp", Subject: "sub-2-" + e, Email: e, EmailVerified: false, Groups: []string{"erp-admins"},
		}, m)
		if !errors.Is(err, providers.ErrRefused) {
			t.Fatalf("err = %v, want ErrRefused", err)
		}
	})

	t.Run("a disabled user stays refused (Review Focus 3)", func(t *testing.T) {
		e := email()
		f.user(e, true)
		_, err := providers.NewProvisioner(f.db).Provision(ctx, f.tenant, providers.ExternalIdentity{
			Provider: "ldap", Subject: "uid=d," + e, Email: e, EmailVerified: true, Groups: []string{"erp-staff"},
		}, m)
		if !errors.Is(err, providers.ErrRefused) {
			t.Fatalf("err = %v, want ErrRefused", err)
		}
	})

	t.Run("no mapped group and no default role is refused", func(t *testing.T) {
		e := email()
		_, err := providers.NewProvisioner(f.db).Provision(ctx, f.tenant, providers.ExternalIdentity{
			Provider: "ldap", Subject: "uid=n," + e, Email: e, EmailVerified: true, Groups: []string{"other"},
		}, m)
		if !errors.Is(err, providers.ErrRefused) {
			t.Fatalf("err = %v, want ErrRefused", err)
		}
		withDefault := m
		withDefault.DefaultRoleID = &f.staff
		id, err := providers.NewProvisioner(f.db).Provision(ctx, f.tenant, providers.ExternalIdentity{
			Provider: "ldap", Subject: "uid=n," + e, Email: e, EmailVerified: true, Groups: []string{"other"},
		}, withDefault)
		if err != nil || !f.roles(id)[f.staff] {
			t.Fatalf("default role: %v, %v", id, err)
		}
	})

	t.Run("an email already linked to another subject of the provider is refused", func(t *testing.T) {
		e := email()
		if _, err := providers.NewProvisioner(f.db).Provision(ctx, f.tenant, providers.ExternalIdentity{
			Provider: "oidc:corp", Subject: "first-" + e, Email: e, EmailVerified: true, Groups: []string{"erp-staff"},
		}, m); err != nil {
			t.Fatal(err)
		}
		_, err := providers.NewProvisioner(f.db).Provision(ctx, f.tenant, providers.ExternalIdentity{
			Provider: "oidc:corp", Subject: "second-" + e, Email: e, EmailVerified: true, Groups: []string{"erp-staff"},
		}, m)
		if !errors.Is(err, providers.ErrRefused) {
			t.Fatalf("err = %v, want ErrRefused", err)
		}
	})

	t.Run("a link to a since-disabled user is refused", func(t *testing.T) {
		e := email()
		id, err := providers.NewProvisioner(f.db).Provision(ctx, f.tenant, providers.ExternalIdentity{
			Provider: "ldap", Subject: "uid=x," + e, Email: e, EmailVerified: true, Groups: []string{"erp-staff"},
		}, m)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = f.db.Exec(ctx, `UPDATE users SET deleted_at = now() WHERE id = $1`, id)
		_, err = providers.NewProvisioner(f.db).Provision(ctx, f.tenant, providers.ExternalIdentity{
			Provider: "ldap", Subject: "uid=x," + e, Email: e, EmailVerified: true, Groups: []string{"erp-staff"},
		}, m)
		if !errors.Is(err, providers.ErrRefused) {
			t.Fatalf("err = %v, want ErrRefused", err)
		}
	})
}
