package auth

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
	"golang.org/x/crypto/bcrypt"
)

var errStep = errors.New("step failed")

// failingSession fails at exactly one step of issuing a session; "" fails none.
type failingSession struct {
	step string
	user Users
}

func (f *failingSession) fail(step string) error {
	if f.step == step {
		return errStep
	}
	return nil
}

func (f *failingSession) FindByEmail(context.Context, string) (Users, error) {
	return f.user, f.fail("find")
}
func (f *failingSession) FindByID(context.Context, uuid.UUID) (Users, error) { return f.user, nil }
func (f *failingSession) FindRoleNames(context.Context, uuid.UUID) ([]string, error) {
	return []string{"admin"}, f.fail("roles")
}
func (f *failingSession) FindGroups(context.Context, uuid.UUID) ([]string, error) {
	return nil, f.fail("groups")
}
func (f *failingSession) ForRoles(context.Context, []string) ([]string, error) {
	return []string{"*:*:*"}, f.fail("permissions")
}
func (f *failingSession) IssueAccess(Users, []string, []string, []string) (string, error) {
	return "access", f.fail("access")
}
func (f *failingSession) IssueRefresh(uuid.UUID) (string, error) { return "refresh", f.fail("refresh") }
func (f *failingSession) ParseRefresh(string) (uuid.UUID, error) { return f.user.ID, nil }
func (f *failingSession) accessTTLSeconds() int                  { return 3600 }
func (f *failingSession) refreshTTLDuration() time.Duration      { return time.Hour }
func (f *failingSession) Save(context.Context, uuid.UUID, string, time.Time) error {
	return f.fail("save")
}
func (f *failingSession) Validate(context.Context, uuid.UUID, string) error { return nil }
func (f *failingSession) RevokeAll(context.Context, uuid.UUID) error        { return nil }

// A failure at any step after the password check is a 500 — never a session
// missing its roles, permissions or refresh token.
func TestLoginAndRefresh_FailAtEveryStep(t *testing.T) {
	hash, err := bcrypt.GenerateFromPassword([]byte("secret-password"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	user := Users{Email: "a@example.com", PasswordHash: string(hash)}
	user.ID = uuid.New()

	run := func(t *testing.T, call echo.HandlerFunc, body string) int {
		t.Helper()
		e := echo.New()
		req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		c := e.NewContext(req, rec)
		if err := call(c); err != nil {
			e.HTTPErrorHandler(c, err)
		}
		return rec.Code
	}

	for _, step := range []string{"roles", "groups", "permissions", "access", "refresh", "save"} {
		t.Run(step, func(t *testing.T) {
			f := &failingSession{step: step, user: user}
			h := NewHandler(f, f, f, f)
			if code := run(t, h.Login, `{"email":"a@example.com","password":"secret-password"}`); code != http.StatusInternalServerError {
				t.Errorf("login: status = %d, want 500", code)
			}
			if code := run(t, h.Refresh, `{"refresh_token":"raw"}`); code != http.StatusInternalServerError {
				t.Errorf("refresh: status = %d, want 500", code)
			}
		})
	}

	t.Run("the user lookup itself fails", func(t *testing.T) {
		f := &failingSession{step: "find", user: user}
		h := NewHandler(f, f, f, f)
		if code := run(t, h.Login, `{"email":"a@example.com","password":"x"}`); code != http.StatusInternalServerError {
			t.Errorf("login: status = %d, want 500", code)
		}
	})

	t.Run("a malformed login body is refused like a wrong password", func(t *testing.T) {
		f := &failingSession{user: user}
		h := NewHandler(f, f, f, f)
		if code := run(t, h.Login, `{`); code != http.StatusUnauthorized {
			t.Errorf("login: status = %d, want 401", code)
		}
		if code := run(t, h.Login, `{"email":"a@example.com","password":"secret-password"}`); code != http.StatusOK {
			t.Errorf("a login where nothing fails: status = %d, want 200", code)
		}
	})
}
