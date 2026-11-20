package office

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"core/internal/auth"
	"core/internal/types"
	"core/orm/model"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

type testUsers struct {
	user    auth.Users
	removed bool
}

func (u *testUsers) FindByID(context.Context, uuid.UUID) (auth.Users, error) {
	if u.removed {
		return auth.Users{}, errors.New("removed")
	}
	return u.user, nil
}
func (*testUsers) FindRoleNames(context.Context, uuid.UUID) ([]string, error) {
	return []string{"staff"}, nil
}
func (*testUsers) FindGroups(context.Context, uuid.UUID) ([]string, error) { return []string{}, nil }

type testObjects struct {
	data map[string][]byte
	puts int
}

func (s *testObjects) Get(_ context.Context, key string) (io.ReadCloser, string, error) {
	return io.NopCloser(bytes.NewReader(s.data[key])), "application/octet-stream", nil
}
func (s *testObjects) Put(_ context.Context, key, _ string, _ int64, reader io.Reader) error {
	b, err := io.ReadAll(reader)
	s.data[key] = b
	s.puts++
	return err
}
func (s *testObjects) Delete(_ context.Context, key string) error { delete(s.data, key); return nil }

type fixture struct {
	service          *Service
	echo             *echo.Echo
	users            *testUsers
	objects          *testObjects
	doc              Document
	visible, replace bool
	result           []byte
	fetched          int
}

func setup(t *testing.T) *fixture {
	t.Helper()
	f := &fixture{visible: true, replace: true}
	user := auth.Users{BaseModel: model.BaseModel{ID: uuid.New(), TenantID: uuid.New()}, DisplayName: "Alice"}
	f.users = &testUsers{user: user}
	f.doc = Document{ID: uuid.New(), Name: "Plan.docx", Mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ObjectKey: "original", Writable: true}
	f.objects = &testObjects{data: map[string][]byte{"original": []byte("old")}}
	f.result, _, _ = Blank("docx")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.fetched++
		if r.URL.Path != "/cache/files/result.docx" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write(f.result)
	}))
	t.Cleanup(server.Close)
	var err error
	f.service, err = New(&types.Config{EuroOfficeURL: "https://office.example/euro-office", EuroOfficeInternalURL: server.URL, EuroOfficeStorageURL: "http://storage.example", EuroOfficeJWTSecret: "test-office-secret-at-least-32-characters"}, f.objects, f.users)
	if err != nil {
		t.Fatal(err)
	}
	f.service.Register("team-file", Source{Resolve: func(c *echo.Context, id uuid.UUID) (Document, bool, error) {
		if !f.visible || id != f.doc.ID {
			return Document{}, false, replyError(c, 404, "NOT_FOUND", "No such document.")
		}
		return f.doc, true, nil
	}, Replace: func(_ *echo.Context, before Document, key string, size int64) (bool, error) {
		if !f.replace || before.ObjectKey != f.doc.ObjectKey {
			return false, nil
		}
		f.doc.ObjectKey, f.doc.Size = key, size
		return true, nil
	}})
	f.echo = echo.New()
	f.service.Mount(f.echo.Group("/api/v1/office"), func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c *echo.Context) error {
			c.SetRequest(c.Request().WithContext(auth.SetIdentity(c.Request().Context(), auth.Identity{UserID: user.ID, TenantID: user.TenantID})))
			return next(c)
		}
	})
	return f
}
func (f *fixture) request(method, target, token string) *httptest.ResponseRecorder {
	u, _ := url.Parse(target)
	r := httptest.NewRequest(method, u.RequestURI(), strings.NewReader(`{"url":"http://attacker.invalid/private"}`))
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	f.echo.ServeHTTP(w, r)
	return w
}
func (f *fixture) session(t *testing.T) map[string]any {
	t.Helper()
	w := f.request("GET", "/api/v1/office/team-file/"+f.doc.ID.String()+"/session?lang=fr", "")
	if w.Code != 200 {
		t.Fatalf("session: %d %s", w.Code, w.Body)
	}
	var result map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result
}
func document(session map[string]any) map[string]any {
	return session["config"].(map[string]any)["document"].(map[string]any)
}
func editor(session map[string]any) map[string]any {
	return session["config"].(map[string]any)["editorConfig"].(map[string]any)
}
func (f *fixture) notification(t *testing.T, session map[string]any, status int, resultURL string) *httptest.ResponseRecorder {
	t.Helper()
	payload := jwt.MapClaims{"payload": map[string]any{"key": document(session)["key"], "status": status, "url": resultURL}}
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, payload).SignedString(f.service.secret)
	if err != nil {
		t.Fatal(err)
	}
	return f.request("POST", editor(session)["callbackUrl"].(string), token)
}

func TestSessionPermissions(t *testing.T) {
	for _, writable := range []bool{false, true} {
		t.Run(map[bool]string{false: "reader", true: "writer"}[writable], func(t *testing.T) {
			f := setup(t)
			f.doc.Writable = writable
			session := f.session(t)
			if session["editable"] != writable {
				t.Fatal(session)
			}
			config := session["config"].(map[string]any)
			claims := jwt.MapClaims{}
			if _, err := jwt.ParseWithClaims(config["token"].(string), claims, func(*jwt.Token) (any, error) { return f.service.secret, nil }, jwt.WithValidMethods([]string{"HS256"})); err != nil {
				t.Fatal(err)
			}
			if claims["document"].(map[string]any)["permissions"].(map[string]any)["edit"] != writable {
				t.Fatal("unsigned permissions")
			}
			_, callback := editor(session)["callbackUrl"]
			if callback != writable {
				t.Fatal("callback permission")
			}
			_, plugins := editor(session)["plugins"]
			if plugins != writable {
				t.Fatal("diagram plugin permission")
			}
			if writable {
				signedEditor := claims["editorConfig"].(map[string]any)
				url := signedEditor["plugins"].(map[string]any)["pluginsData"].([]any)[0]
				if url != "https://office.example/euro-office/sdkjs-plugins/erp-diagrams/config.json" {
					t.Fatal(url)
				}
			}
			if editor(session)["lang"] != "fr" {
				t.Fatal("locale")
			}
		})
	}
}
func TestContentScopeAndRevocation(t *testing.T) {
	f := setup(t)
	session := f.session(t)
	target := document(session)["url"].(string)
	if w := f.request("GET", target, ""); w.Code != 200 || w.Body.String() != "old" {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	f.visible = false
	if w := f.request("GET", target, ""); w.Code != 404 {
		t.Fatal(w.Code)
	}
	f.visible = true
	f.users.removed = true
	if w := f.request("GET", target, ""); w.Code != 401 {
		t.Fatal(w.Code)
	}
}
func TestGrantCannotBeUsedOnOtherRoutes(t *testing.T) {
	f := setup(t)
	session := f.session(t)
	target := document(session)["url"].(string)
	for _, bad := range []string{strings.Replace(target, "/content?", "/callback?", 1), strings.Replace(target, f.doc.ID.String(), uuid.NewString(), 1), strings.Replace(target, "team-file", "attachment", 1)} {
		if w := f.request("GET", bad, ""); w.Code == 200 {
			t.Fatal("grant crossed boundary", bad)
		}
	}
}
func TestCallbackSaveAndDuplicate(t *testing.T) {
	f := setup(t)
	session := f.session(t)
	for i := 0; i < 2; i++ {
		w := f.notification(t, session, 2, "https://office.example/euro-office/cache/files/result.docx")
		if w.Code != 200 || !strings.Contains(w.Body.String(), `"error":0`) {
			t.Fatalf("%d %s", w.Code, w.Body)
		}
	}
	if f.objects.puts != 1 || f.fetched != 1 || !bytes.Equal(f.objects.data[f.doc.ObjectKey], f.result) {
		t.Fatal("save was not atomic/idempotent")
	}
	if _, exists := f.objects.data["original"]; exists {
		t.Fatal("old object retained")
	}
}
func TestCallbackRejectsUnauthorizedSaves(t *testing.T) {
	for _, kind := range []string{"no-signature", "revoked", "reader", "conflict", "cas-failure", "force-save", "unsafe-url", "bad-response"} {
		t.Run(kind, func(t *testing.T) {
			f := setup(t)
			session := f.session(t)
			status := 2
			result := "https://office.example/euro-office/cache/files/result.docx"
			switch kind {
			case "no-signature":
				w := f.request("POST", editor(session)["callbackUrl"].(string), "")
				if w.Code != 401 {
					t.Fatal(w.Code)
				}
				return
			case "revoked":
				f.visible = false
			case "reader":
				f.doc.Writable = false
			case "conflict":
				f.doc.ObjectKey = "newer"
			case "cas-failure":
				f.replace = false
			case "force-save":
				status = 6
			case "unsafe-url":
				result = "http://169.254.169.254/latest/meta-data"
			case "bad-response":
				f.result = []byte("<html>Bad gateway</html>")
			}
			w := f.notification(t, session, status, result)
			if w.Code == 200 && strings.Contains(w.Body.String(), `"error":0`) {
				t.Fatal("accepted invalid save")
			}
			if f.doc.ObjectKey != "original" && f.doc.ObjectKey != "newer" {
				t.Fatal("modified metadata")
			}
			if len(f.objects.data) != 1 {
				t.Fatal("left orphaned object")
			}
		})
	}
}
func TestResultURLAllowlist(t *testing.T) {
	f := setup(t)
	for _, raw := range []string{"https://office.example.evil/cache/files/x", "https://office.example/euro-office/cache/files/../secret", "https://office.example/euro-office/cache/files/%2e%2e/secret", "https://user@office.example/euro-office/cache/files/x", "https://office.example/other/cache/files/x", "https://office.example/euro-office/cache/files/x#fragment"} {
		if _, err := f.service.resultURL(raw); err == nil {
			t.Error("accepted", raw)
		}
	}
}
func TestTemplates(t *testing.T) {
	for _, kind := range []string{"docx", "xlsx", "pptx"} {
		t.Run(kind, func(t *testing.T) {
			data, mime, err := Blank(kind)
			if err != nil || !strings.HasPrefix(mime, "application/vnd.openxmlformats-") {
				t.Fatal(mime, err)
			}
			archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
			if err != nil {
				t.Fatal(err)
			}
			if kind == "pptx" {
				theme, err := archive.Open("ppt/theme/theme1.xml")
				if err != nil {
					t.Fatal("a presentation master requires a theme", err)
				}
				theme.Close()
				relations, err := archive.Open("ppt/slideMasters/_rels/slideMaster1.xml.rels")
				if err != nil {
					t.Fatal(err)
				}
				body, _ := io.ReadAll(relations)
				relations.Close()
				if !bytes.Contains(body, []byte(officeRelations+"/theme")) {
					t.Fatal("the presentation master does not reference its theme")
				}
			}
			for _, part := range archive.File {
				r, err := part.Open()
				if err != nil {
					t.Fatal(err)
				}
				decoder := xml.NewDecoder(r)
				for {
					_, err = decoder.Token()
					if err == io.EOF {
						break
					}
					if err != nil {
						t.Fatalf("%s: %s", part.Name, err)
					}
				}
				r.Close()
			}
		})
	}
	if _, _, err := Blank("html"); err == nil {
		t.Fatal("unknown template")
	}
}
func TestOptionalConfiguration(t *testing.T) {
	if _, err := New(&types.Config{}, nil, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := New(&types.Config{EuroOfficeJWTSecret: "short"}, nil, nil); err == nil {
		t.Fatal("short secret")
	}
}
