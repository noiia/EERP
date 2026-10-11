// core/internal/auth/providers/provision_test.go
package providers_test

import (
	"context"
	"errors"
	"strings"
	"sync"
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
		if got := f.roles(id); len(got) != 1 || !got[f.staff] {
			t.Errorf("roles = %v, want staff", got)
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
		withDefault.LDAP = &providers.LDAPConfig{DefaultRoleID: &f.staff}
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

	prov := func(e, sub string, verified bool, groups []string, mm providers.Methods) (uuid.UUID, error) {
		return providers.NewProvisioner(f.db).Provision(ctx, f.tenant, providers.ExternalIdentity{
			Provider: "ldap", Subject: sub, Email: e, EmailVerified: verified, Groups: groups,
		}, mm)
	}
	count := func(q string, args ...any) int {
		var n int
		if err := f.db.QueryRow(ctx, q, args...).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}

	t.Run("unverified email with no account is refused and creates nothing", func(t *testing.T) {
		e := email()
		if _, err := prov(e, "uid=u,"+e, false, []string{"erp-staff"}, m); !errors.Is(err, providers.ErrRefused) {
			t.Fatalf("err = %v", err)
		}
		if n := count(`SELECT count(*) FROM users WHERE tenant_id=$1 AND lower(email)=$2`, f.tenant, e); n != 0 {
			t.Errorf("%d users created", n)
		}
	})

	t.Run("an email held by a website user is refused", func(t *testing.T) {
		e := email()
		if _, err := f.db.Exec(ctx, `INSERT INTO users (id, tenant_id, email, password_hash, kind) VALUES ($1,$2,$3,'x','website')`, uuid.New(), f.tenant, e); err != nil {
			t.Fatal(err)
		}
		if _, err := prov(e, "uid=w,"+e, true, []string{"erp-staff"}, m); !errors.Is(err, providers.ErrRefused) {
			t.Fatalf("err = %v", err)
		}
		if n := count(`SELECT count(*) FROM users WHERE tenant_id=$1 AND lower(email)=$2 AND kind=''`, f.tenant, e); n != 0 {
			t.Errorf("%d ERP users created", n)
		}
	})

	t.Run("concurrent first logins never error", func(t *testing.T) {
		e := email()
		var wg sync.WaitGroup
		ids := make([]uuid.UUID, 2)
		errs := make([]error, 2)
		for i := range ids {
			wg.Add(1)
			go func() {
				defer wg.Done()
				ids[i], errs[i] = prov(e, "uid=c,"+e, true, []string{"erp-staff"}, m)
			}()
		}
		wg.Wait()
		ok := 0
		for i := range ids {
			switch {
			case errs[i] == nil:
				ok++
			case !errors.Is(errs[i], providers.ErrRefused):
				t.Fatalf("err = %v", errs[i])
			}
		}
		if ok == 0 {
			t.Fatal("no login succeeded")
		}
		if n := count(`SELECT count(*) FROM users WHERE tenant_id=$1 AND lower(email)=$2`, f.tenant, e); n != 1 {
			t.Errorf("%d users", n)
		}
	})

	t.Run("a role of another tenant or a deleted role grants nothing", func(t *testing.T) {
		foreign, gone := uuid.New(), uuid.New()
		other := uuid.New()
		t.Cleanup(func() { _, _ = f.db.Exec(ctx, `DELETE FROM roles WHERE tenant_id = $1`, other) })
		if _, err := f.db.Exec(ctx, `INSERT INTO roles (id, tenant_id, name, description) VALUES ($1,$2,$3,'')`, foreign, other, "ext-foreign-"+other.String()[:8]); err != nil {
			t.Fatal(err)
		}
		if _, err := f.db.Exec(ctx, `INSERT INTO roles (id, tenant_id, name, description, deleted_at) VALUES ($1,$2,$3,'',now())`, gone, f.tenant, "ext-gone-"+f.tenant.String()[:8]); err != nil {
			t.Fatal(err)
		}
		for _, rid := range []uuid.UUID{foreign, gone} {
			e := email()
			mm := providers.Methods{RoleMapping: []providers.RoleMapping{{Group: "g", RoleID: rid}}}
			if _, err := prov(e, "uid=r,"+e, true, []string{"g"}, mm); !errors.Is(err, providers.ErrRefused) {
				t.Fatalf("role %v: err = %v", rid, err)
			}
			if n := count(`SELECT count(*) FROM user_roles WHERE role_id = $1`, rid); n != 0 {
				t.Errorf("role %v granted", rid)
			}
		}
	})

	t.Run("manual roles survive; only managed roles are synced", func(t *testing.T) {
		e := email()
		existing := f.user(e, false)
		if _, err := f.db.Exec(ctx, `INSERT INTO user_roles (id, tenant_id, user_id, role_id) VALUES ($1,$2,$3,$4)`, uuid.New(), f.tenant, existing, f.admin); err != nil {
			t.Fatal(err)
		}
		staffOnly := providers.Methods{RoleMapping: []providers.RoleMapping{{Group: "erp-staff", RoleID: f.staff}}}
		id, err := prov(e, "uid=m,"+e, true, []string{"erp-staff"}, staffOnly)
		if err != nil || id != existing {
			t.Fatalf("got %v, %v; want %v", id, err, existing)
		}
		if got := f.roles(id); len(got) != 2 || !got[f.admin] || !got[f.staff] {
			t.Errorf("roles = %v, want manual admin kept + staff granted", got)
		}
		// Leaving the group drops the managed staff role, never the manual admin.
		if _, err := prov(e, "uid=m,"+e, true, nil, staffOnly); err != nil {
			t.Fatalf("sign-in with a manual role left = %v", err)
		}
		if got := f.roles(id); len(got) != 1 || !got[f.admin] {
			t.Errorf("roles = %v, want only the manual admin", got)
		}
	})

	t.Run("a managed role the user no longer qualifies for is removed", func(t *testing.T) {
		e := email()
		id, err := prov(e, "uid=l,"+e, true, []string{"erp-admins", "erp-staff"}, m)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := prov(e, "uid=l,"+e, true, []string{"erp-staff"}, m); err != nil {
			t.Fatal(err)
		}
		if got := f.roles(id); len(got) != 1 || !got[f.staff] {
			t.Errorf("roles = %v, want staff only", got)
		}
		// Losing every managed role with no manual one left is refused, rolled back.
		if _, err := prov(e, "uid=l,"+e, true, nil, m); !errors.Is(err, providers.ErrRefused) {
			t.Fatalf("err = %v, want ErrRefused", err)
		}
		if got := f.roles(id); len(got) != 1 || !got[f.staff] {
			t.Errorf("roles after refused sign-in = %v, want unchanged", got)
		}
	})

	oidc := func(provider, e string, groups []string, mm providers.Methods) (uuid.UUID, error) {
		return providers.NewProvisioner(f.db).Provision(ctx, f.tenant, providers.ExternalIdentity{
			Provider: provider, Subject: "sub-" + e, Email: e, EmailVerified: true, Groups: groups,
		}, mm)
	}

	t.Run("a default role applies only to its own method", func(t *testing.T) {
		mm := providers.Methods{
			LDAP: &providers.LDAPConfig{DefaultRoleID: &f.staff},
			OIDC: []providers.OIDCProvider{{ID: "x"}, {ID: "y", DefaultRoleID: &f.admin}},
		}
		if _, err := oidc("oidc:x", email(), nil, mm); !errors.Is(err, providers.ErrRefused) {
			t.Fatalf("ldap default applied to oidc:x: err = %v", err)
		}
		id, err := oidc("oidc:y", email(), nil, mm)
		if err != nil {
			t.Fatal(err)
		}
		if got := f.roles(id); len(got) != 1 || !got[f.admin] {
			t.Errorf("oidc:y roles = %v, want its own default (admin)", got)
		}
		e := email()
		id, err = prov(e, "uid=dd,"+e, true, nil, mm)
		if err != nil {
			t.Fatal(err)
		}
		if got := f.roles(id); len(got) != 1 || !got[f.staff] {
			t.Errorf("ldap roles = %v, want its default (staff)", got)
		}
	})

	t.Run("a mapping scoped to a method applies to that method only", func(t *testing.T) {
		mm := providers.Methods{
			OIDC: []providers.OIDCProvider{{ID: "x"}},
			RoleMapping: []providers.RoleMapping{
				{Group: "g-ldap", RoleID: f.admin, Method: "ldap"},
				{Group: "g-x", RoleID: f.staff, Method: "oidc:x"},
			},
		}
		if _, err := oidc("oidc:x", email(), []string{"g-ldap"}, mm); !errors.Is(err, providers.ErrRefused) {
			t.Errorf("ldap-scoped mapping applied to oidc:x: err = %v", err)
		}
		e := email()
		if _, err := prov(e, "uid=sc,"+e, true, []string{"g-x"}, mm); !errors.Is(err, providers.ErrRefused) {
			t.Errorf("oidc:x-scoped mapping applied to ldap: err = %v", err)
		}
		id, err := oidc("oidc:x", email(), []string{"g-x"}, mm)
		if err != nil || !f.roles(id)[f.staff] {
			t.Errorf("oidc:x own mapping: %v, %v", id, err)
		}
		e = email()
		id, err = prov(e, "uid=sc2,"+e, true, []string{"g-ldap"}, mm)
		if err != nil || !f.roles(id)[f.admin] {
			t.Errorf("ldap own mapping: %v, %v", id, err)
		}
	})

	t.Run("allowed_domains admits only listed verified domains", func(t *testing.T) {
		mm := providers.Methods{
			OIDC:        []providers.OIDCProvider{{ID: "g", AllowedDomains: []string{"corp.test"}}},
			RoleMapping: []providers.RoleMapping{{Group: "erp-staff", RoleID: f.staff}},
		}
		other := uuid.NewString()[:8] + "@gmail.test"
		if _, err := oidc("oidc:g", other, []string{"erp-staff"}, mm); !errors.Is(err, providers.ErrRefused) {
			t.Errorf("other domain: err = %v, want ErrRefused", err)
		}
		if n := count(`SELECT count(*) FROM users WHERE tenant_id=$1 AND lower(email)=$2`, f.tenant, other); n != 0 {
			t.Errorf("%d users created for a refused domain", n)
		}
		if _, err := oidc("oidc:g", uuid.NewString()[:8]+"@corp.test", []string{"erp-staff"}, mm); err != nil {
			t.Errorf("listed domain: err = %v", err)
		}
	})

	t.Run("UnlinkProvider removes only that provider's links in that tenant", func(t *testing.T) {
		e1, e2 := email(), email()
		u1, err := oidc("oidc:unl", e1, []string{"erp-staff"}, m)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := prov(e2, "uid=keep,"+e2, true, []string{"erp-staff"}, m); err != nil {
			t.Fatal(err)
		}
		other := uuid.New()
		t.Cleanup(func() { _, _ = f.db.Exec(ctx, `DELETE FROM auth_identity WHERE tenant_id = $1`, other) })
		if _, err := f.db.Exec(ctx, `INSERT INTO auth_identity (id, tenant_id, user_id, provider, subject) VALUES ($1,$2,$3,'oidc:unl','foreign')`, uuid.New(), other, u1); err != nil {
			t.Fatal(err)
		}
		if err := providers.NewProvisioner(f.db).UnlinkProvider(ctx, f.tenant, "oidc:unl"); err != nil {
			t.Fatal(err)
		}
		live := func(tenant uuid.UUID, provider string) int {
			return count(`SELECT count(*) FROM auth_identity WHERE tenant_id=$1 AND provider=$2 AND deleted_at IS NULL`, tenant, provider)
		}
		if n := live(f.tenant, "oidc:unl"); n != 0 {
			t.Errorf("%d oidc:unl links left", n)
		}
		if n := live(f.tenant, "ldap"); n == 0 {
			t.Error("ldap links were removed too")
		}
		if n := live(other, "oidc:unl"); n != 1 {
			t.Errorf("another tenant's link removed (%d left)", n)
		}
		// The next sign-in of the same subject relinks through the verified email.
		if again, err := oidc("oidc:unl", e1, []string{"erp-staff"}, m); err != nil || again != u1 {
			t.Errorf("relink = %v, %v; want %v", again, err, u1)
		}
	})

	t.Run("a soft-deleted identity relinks through the email rules", func(t *testing.T) {
		e := email()
		id, err := prov(e, "uid=s,"+e, true, []string{"erp-staff"}, m)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.db.Exec(ctx, `UPDATE auth_identity SET deleted_at = now() WHERE user_id = $1`, id); err != nil {
			t.Fatal(err)
		}
		again, err := prov(e, "uid=s,"+e, true, []string{"erp-staff"}, m)
		if err != nil || again != id {
			t.Fatalf("got %v, %v; want %v", again, err, id)
		}
	})
}
