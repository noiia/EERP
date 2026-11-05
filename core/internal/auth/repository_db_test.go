package auth_test

import (
	"context"
	"errors"
	"testing"

	"core/internal/auth"
	"core/internal/testdb"
	"core/orm"

	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"
)

// The user/role repositories against a real database: the paths only a real
// row (or its absence) can reach — unknown ids, another tenant's rows, unique
// technical names, credential rotation.
func TestUserRepository_Writes(t *testing.T) {
	app, _ := integrationSetup(t)
	tenant := newTenant(t, app)
	ctx := context.Background()
	users := auth.NewUserRepository(app.DB)
	id := seedUser(t, app.DB, "writer-"+uuid.NewString()[:8]+"@example.com", "old-password", tenant)

	t.Run("preferred locale and active company: set, cleared, unknown user", func(t *testing.T) {
		fr := "fr"
		if err := users.SetPreferredLocale(ctx, id, &fr); err != nil {
			t.Fatal(err)
		}
		if u, _ := users.FindByID(ctx, id); u.PreferredLocale == nil || *u.PreferredLocale != "fr" {
			t.Fatalf("preferred locale = %v, want fr", u.PreferredLocale)
		}
		if err := users.SetPreferredLocale(ctx, id, nil); err != nil {
			t.Fatal(err)
		}
		company := uuid.New()
		if err := users.SetActiveCompany(ctx, id, &company); err != nil {
			t.Fatal(err)
		}
		if err := users.SetPreferredLocale(ctx, uuid.New(), &fr); !errors.Is(err, orm.ErrNotFound) {
			t.Fatalf("unknown user: %v, want ErrNotFound", err)
		}
		if err := users.SetActiveCompany(ctx, uuid.New(), nil); !errors.Is(err, orm.ErrNotFound) {
			t.Fatalf("unknown user: %v, want ErrNotFound", err)
		}
	})

	t.Run("a user is only found in its own tenant", func(t *testing.T) {
		if _, err := users.FindInTenant(ctx, uuid.New(), id); !errors.Is(err, orm.ErrNotFound) {
			t.Fatalf("other tenant: %v, want ErrNotFound", err)
		}
		if _, err := users.UpdateProfile(ctx, uuid.New(), id, auth.UserProfile{Email: "x@example.com"}); !errors.Is(err, orm.ErrNotFound) {
			t.Fatalf("update in other tenant: %v, want ErrNotFound", err)
		}
	})

	t.Run("a new password replaces the credential and clears a forced change", func(t *testing.T) {
		if _, err := app.DB.Exec(ctx, `UPDATE users SET must_change_password = true WHERE id = $1`, id); err != nil {
			t.Fatal(err)
		}
		u, err := users.FindInTenant(ctx, tenant, id)
		if err != nil {
			t.Fatal(err)
		}
		updated, err := users.UpdateProfile(ctx, tenant, id, auth.UserProfile{Email: u.Email, Password: "new-password"})
		if err != nil {
			t.Fatal(err)
		}
		if updated.MustChangePassword {
			t.Error("a password change must clear must_change_password")
		}
		if bcrypt.CompareHashAndPassword([]byte(updated.PasswordHash), []byte("new-password")) != nil {
			t.Error("the new password must verify")
		}
	})

	t.Run("website profile and preferences of an unknown account", func(t *testing.T) {
		if err := users.UpdateWebsiteProfile(ctx, tenant, uuid.New(), auth.WebsiteProfile{Name: "A"}); !errors.Is(err, orm.ErrNotFound) {
			t.Fatalf("profile: %v, want ErrNotFound", err)
		}
		eur := "EUR"
		if err := users.SetWebsitePreferences(ctx, tenant, uuid.New(), nil, &eur); !errors.Is(err, orm.ErrNotFound) {
			t.Fatalf("preferences: %v, want ErrNotFound", err)
		}
	})
}

func TestRoleRepository_Writes(t *testing.T) {
	app, _ := integrationSetup(t)
	tenant := newTenant(t, app)
	ctx := context.Background()
	roles := auth.NewRoleRepository(app.DB)
	slug := "sales_" + uuid.NewString()[:8]

	sales, err := roles.CreateRole(ctx, tenant, "Sales", "", &slug)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := roles.CreateRole(ctx, tenant, "Sales 2", "", &slug); !errors.Is(err, auth.ErrDuplicateTechnicalName) {
		t.Fatalf("duplicate technical name on create: %v", err)
	}
	other, err := roles.CreateRole(ctx, tenant, "Support", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := roles.UpdateRole(ctx, tenant, other.ID, "Support", "", &slug); !errors.Is(err, auth.ErrDuplicateTechnicalName) {
		t.Fatalf("duplicate technical name on update: %v", err)
	}
	if _, err := roles.UpdateRole(ctx, uuid.New(), sales.ID, "Sales", "", nil); !errors.Is(err, orm.ErrNotFound) {
		t.Fatalf("update in other tenant: %v, want ErrNotFound", err)
	}
	if _, err := roles.FindInTenant(ctx, uuid.New(), sales.ID); !errors.Is(err, orm.ErrNotFound) {
		t.Fatalf("find in other tenant: %v, want ErrNotFound", err)
	}
}

// A database that can't be reached surfaces as an error from every method —
// never as an empty result a handler would answer 200 with.
func TestRepositories_DatabaseDown(t *testing.T) {
	down := testdb.Closed(t)
	ctx := context.Background()
	users := auth.NewUserRepository(down.DB)
	roles := auth.NewRoleRepository(down.DB)
	tenant, id := uuid.New(), uuid.New()
	fr := "fr"

	calls := map[string]func() error{
		"FindByEmail":        func() error { _, err := users.FindByEmail(ctx, "a@example.com"); return err },
		"FindByID":           func() error { _, err := users.FindByID(ctx, id); return err },
		"SetPreferredLocale": func() error { return users.SetPreferredLocale(ctx, id, &fr) },
		"SetActiveCompany":   func() error { return users.SetActiveCompany(ctx, id, nil) },
		"FindRoleNames":      func() error { _, err := users.FindRoleNames(ctx, id); return err },
		"FindGroups":         func() error { _, err := users.FindGroups(ctx, id); return err },
		"ListByTenant":       func() error { _, err := users.ListByTenant(ctx, tenant); return err },
		"FindInTenant":       func() error { _, err := users.FindInTenant(ctx, tenant, id); return err },
		"CreateUser": func() error {
			_, err := users.CreateUser(ctx, tenant, auth.UserProfile{Email: "a@example.com"})
			return err
		},
		"CreateWebsiteUser": func() error {
			_, err := users.CreateWebsiteUser(ctx, tenant, "a@example.com", "password1", "A", "")
			return err
		},
		"ResendVerification":   func() error { return users.ResendVerification(ctx, tenant, id, "") },
		"UpdateWebsiteProfile": func() error { return users.UpdateWebsiteProfile(ctx, tenant, id, auth.WebsiteProfile{}) },
		"SetWebsitePrefs":      func() error { return users.SetWebsitePreferences(ctx, tenant, id, &fr, nil) },
		"ListWebsiteUsers":     func() error { _, err := users.ListWebsiteUsers(ctx, tenant); return err },
		"FindWebsiteUser":      func() error { _, err := users.FindWebsiteUser(ctx, tenant, id); return err },
		"Roles.ListByTenant":   func() error { _, err := roles.ListByTenant(ctx, tenant); return err },
		"Roles.FindInTenant":   func() error { _, err := roles.FindInTenant(ctx, tenant, id); return err },
		"Roles.CreateRole":     func() error { _, err := roles.CreateRole(ctx, tenant, "R", "", nil); return err },
		"Roles.UpdateRole":     func() error { _, err := roles.UpdateRole(ctx, tenant, id, "R", "", nil); return err },
	}
	for name, call := range calls {
		t.Run(name, func(t *testing.T) {
			if err := call(); err == nil {
				t.Fatal("want an error on a closed database")
			}
		})
	}
}
