package providers_test

import (
	"bytes"
	"context"
	"errors"
	"io"
	"testing"

	"core/internal/auth/providers"
	"core/internal/common"
	"core/internal/pictures"
	"core/internal/testdb"
	_ "core/modules/auth"
	_ "core/modules/pictures"

	"github.com/google/uuid"
	"go.uber.org/zap"
)

type memObjects struct {
	objs   map[string][]byte
	puts   int
	putErr error
}

func (m *memObjects) Put(_ context.Context, key, _ string, _ int64, body io.Reader) error {
	if m.putErr != nil {
		return m.putErr
	}
	b, _ := io.ReadAll(body)
	m.objs[key] = b
	m.puts++
	return nil
}
func (m *memObjects) Get(_ context.Context, key string) (io.ReadCloser, string, error) {
	return io.NopCloser(bytes.NewReader(m.objs[key])), "", nil
}
func (m *memObjects) Delete(_ context.Context, key string) error {
	delete(m.objs, key)
	return nil
}

var (
	pngBytes  = append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, 32)...)
	jpegBytes = append([]byte("\xff\xd8\xff\xe0"), make([]byte, 32)...)
)

type photoFixture struct {
	sync    *providers.PhotoSync
	objects *memObjects
	repo    *pictures.Repository
	tenant  uuid.UUID
	user    uuid.UUID
	flag    func() *bool
}

func newPhotoFixture(t *testing.T) photoFixture {
	if common.Logger == nil {
		common.Logger = zap.NewNop()
	}
	app := testdb.Open(t)
	testdb.MigrateModules(t, app, "auth", "pictures")
	ctx := context.Background()
	tenant := uuid.New()
	t.Cleanup(func() {
		_, _ = app.DB.Exec(ctx, `DELETE FROM picture WHERE tenant_id = $1`, tenant)
		_, _ = app.DB.Exec(ctx, `DELETE FROM users WHERE tenant_id = $1`, tenant)
	})
	var user uuid.UUID
	if err := app.DB.QueryRow(ctx, `INSERT INTO users (tenant_id, email) VALUES ($1, $2) RETURNING id`,
		tenant, uuid.NewString()+"@photo.test").Scan(&user); err != nil {
		t.Fatal(err)
	}
	repo := pictures.NewRepository(app.DB)
	objects := &memObjects{objs: map[string][]byte{}}
	return photoFixture{
		sync: providers.NewPhotoSync(repo, objects, repo), objects: objects, repo: repo, tenant: tenant, user: user,
		flag: func() *bool {
			var v *bool
			_ = app.DB.QueryRow(ctx, `SELECT avatar FROM users WHERE id = $1`, user).Scan(&v)
			return v
		},
	}
}

func (f photoFixture) picture(t *testing.T) (pictures.Picture, bool) {
	p, err := f.repo.FindByAnchor(context.Background(), f.tenant, "users", f.user, "avatar")
	return p, err == nil
}

func TestPhotoSync_StoresNewPhoto(t *testing.T) {
	f := newPhotoFixture(t)
	f.sync.Sync(context.Background(), f.tenant, f.user, pngBytes)
	p, ok := f.picture(t)
	if !ok || p.Mime != "image/png" || len(f.objects.objs) != 1 || f.objects.objs[p.ObjectKey] == nil {
		t.Fatalf("picture = %+v ok=%v objects=%d", p, ok, len(f.objects.objs))
	}
	if want := f.tenant.String() + "/users/" + f.user.String() + "/avatar-"; len(p.ObjectKey) != len(want)+16 || p.ObjectKey[:len(want)] != want {
		t.Errorf("key = %q", p.ObjectKey)
	}
	if v := f.flag(); v == nil || !*v {
		t.Errorf("flag = %v, want true", v)
	}
}

func TestPhotoSync_SameBytesNoRewrite(t *testing.T) {
	f := newPhotoFixture(t)
	f.sync.Sync(context.Background(), f.tenant, f.user, pngBytes)
	f.sync.Sync(context.Background(), f.tenant, f.user, pngBytes)
	if f.objects.puts != 1 {
		t.Errorf("puts = %d, want 1", f.objects.puts)
	}
}

func TestPhotoSync_ChangedReplacesAndDeletesOld(t *testing.T) {
	f := newPhotoFixture(t)
	f.sync.Sync(context.Background(), f.tenant, f.user, pngBytes)
	old, _ := f.picture(t)
	f.sync.Sync(context.Background(), f.tenant, f.user, jpegBytes)
	p, ok := f.picture(t)
	if !ok || p.ID != old.ID || p.ObjectKey == old.ObjectKey || p.Mime != "image/jpeg" {
		t.Fatalf("picture = %+v (old %+v)", p, old)
	}
	if _, still := f.objects.objs[old.ObjectKey]; still || len(f.objects.objs) != 1 {
		t.Errorf("old object kept: %v", f.objects.objs)
	}
}

func TestPhotoSync_EmptyClears(t *testing.T) {
	f := newPhotoFixture(t)
	f.sync.Sync(context.Background(), f.tenant, f.user, pngBytes)
	f.sync.Sync(context.Background(), f.tenant, f.user, nil)
	if _, ok := f.picture(t); ok {
		t.Error("picture row kept")
	}
	if v := f.flag(); v == nil || *v {
		t.Errorf("flag = %v, want false", v)
	}
	if len(f.objects.objs) != 0 {
		t.Errorf("objects = %v", f.objects.objs)
	}
}

func TestPhotoSync_OversizeOrNotImageIgnored(t *testing.T) {
	f := newPhotoFixture(t)
	f.sync.Sync(context.Background(), f.tenant, f.user, pngBytes)
	before, _ := f.picture(t)
	big := append(append([]byte{}, pngBytes...), make([]byte, 2<<20)...)
	for name, photo := range map[string][]byte{"oversize": big, "gif": []byte("GIF89a......"), "text": []byte("hello")} {
		f.sync.Sync(context.Background(), f.tenant, f.user, photo)
		if p, ok := f.picture(t); !ok || p.ObjectKey != before.ObjectKey || f.objects.puts != 1 {
			t.Errorf("%s: picture changed: %+v puts=%d", name, p, f.objects.puts)
		}
	}
}

func TestPhotoSync_StoreErrorDoesNotPanic(t *testing.T) {
	f := newPhotoFixture(t)
	f.objects.putErr = errors.New("s3 down")
	f.sync.Sync(context.Background(), f.tenant, f.user, pngBytes)
	if _, ok := f.picture(t); ok {
		t.Error("row written although the object was not")
	}
	if v := f.flag(); v != nil && *v {
		t.Error("flag set although the object was not stored")
	}
}
