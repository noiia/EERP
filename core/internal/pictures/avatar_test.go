package pictures_test

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"core/internal/auth"
	"core/internal/pictures"
	"core/internal/testdb"
	_ "core/modules/auth"
	_ "core/modules/pictures"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

type avatarObjects struct{ objs map[string][]byte }

func (m avatarObjects) Put(_ context.Context, key, _ string, _ int64, body io.Reader) error {
	b, _ := io.ReadAll(body)
	m.objs[key] = b
	return nil
}
func (m avatarObjects) Get(_ context.Context, key string) (io.ReadCloser, string, error) {
	return io.NopCloser(bytes.NewReader(m.objs[key])), "application/octet-stream", nil
}
func (m avatarObjects) Delete(_ context.Context, key string) error {
	delete(m.objs, key)
	return nil
}

func TestAvatarHandler_Get(t *testing.T) {
	app := testdb.Open(t)
	testdb.MigrateModules(t, app, "auth", "pictures")
	ctx := context.Background()
	tenant, other := uuid.New(), uuid.New()
	t.Cleanup(func() {
		_, _ = app.DB.Exec(ctx, `DELETE FROM picture WHERE tenant_id = ANY($1)`, []uuid.UUID{tenant, other})
		_, _ = app.DB.Exec(ctx, `DELETE FROM users WHERE tenant_id = ANY($1)`, []uuid.UUID{tenant, other})
	})
	newUser := func(tenant uuid.UUID, kind string) uuid.UUID {
		var id uuid.UUID
		if err := app.DB.QueryRow(ctx, `INSERT INTO users (tenant_id, email, kind) VALUES ($1, $2, $3) RETURNING id`,
			tenant, uuid.NewString()+"@avatar.test", kind).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	repo := pictures.NewRepository(app.DB)
	objects := avatarObjects{objs: map[string][]byte{}}
	withAvatar := func(tenant, user uuid.UUID) {
		key := tenant.String() + "/users/" + user.String() + "/avatar-x"
		objects.objs[key] = []byte("png-bytes")
		if _, err := repo.Create(ctx, pictures.Picture{TenantID: tenant, TableName: "users", RecordID: user, Field: "avatar", ObjectKey: key, Mime: "image/png", Size: 9}); err != nil {
			t.Fatal(err)
		}
	}
	staff, bare, foreign, visitor := newUser(tenant, ""), newUser(tenant, ""), newUser(other, ""), newUser(tenant, auth.KindWebsite)
	withAvatar(tenant, staff)
	withAvatar(other, foreign)
	withAvatar(tenant, visitor)

	h := pictures.NewAvatarHandler(repo, objects, auth.NewUserRepository(app.DB))
	get := func(user string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/avatars/"+user, nil)
		req = req.WithContext(auth.SetIdentity(req.Context(), auth.Identity{UserID: uuid.New(), TenantID: tenant}))
		rec := httptest.NewRecorder()
		c := echo.New().NewContext(req, rec)
		c.SetPathValues(echo.PathValues{echo.PathValue{Name: "user", Value: user}})
		if err := h.Get(c); err != nil {
			t.Fatal(err)
		}
		return rec
	}

	rec := get(staff.String())
	if rec.Code != http.StatusOK || rec.Body.String() != "png-bytes" ||
		rec.Header().Get("Cache-Control") != "private, max-age=300" || rec.Header().Get("Content-Type") != "image/png" {
		t.Fatalf("staff avatar = %d %q %v", rec.Code, rec.Body.String(), rec.Header())
	}
	for name, user := range map[string]uuid.UUID{"no avatar": bare, "other tenant": foreign, "website user": visitor} {
		if rec := get(user.String()); rec.Code != http.StatusNotFound {
			t.Errorf("%s = %d, want 404", name, rec.Code)
		}
	}
	if rec := get("not-a-uuid"); rec.Code != http.StatusBadRequest {
		t.Errorf("bad id = %d, want 400", rec.Code)
	}
}
