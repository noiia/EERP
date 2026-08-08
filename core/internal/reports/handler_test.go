package reports

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"core/internal/auth"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
)

// ── Stubs ─────────────────────────────────────────────────────────────────────

type stubRenderer struct {
	gotURL string
	pdf    []byte
	err    error
}

func (s *stubRenderer) Render(_ context.Context, printURL string) ([]byte, error) {
	s.gotURL = printURL
	return s.pdf, s.err
}

type stubObjects struct {
	putKey  string
	putData []byte
	putErr  error

	getBody string
	getErr  error
}

func (s *stubObjects) Put(_ context.Context, key, _ string, _ int64, body io.Reader) error {
	if s.putErr != nil {
		return s.putErr
	}
	data, err := io.ReadAll(body)
	if err != nil {
		return err
	}
	s.putKey = key
	s.putData = data
	return nil
}

func (s *stubObjects) Get(_ context.Context, _ string) (io.ReadCloser, string, error) {
	if s.getErr != nil {
		return nil, "", s.getErr
	}
	return io.NopCloser(strings.NewReader(s.getBody)), "application/pdf", nil
}

func (s *stubObjects) Delete(_ context.Context, _ string) error { return nil }

type stubPermissions struct {
	hasResult bool
	hasErr    error
	roles     []string
	forRoles  []string
	forErr    error
}

func (s *stubPermissions) Has(_ context.Context, roles []string, _ string) (bool, error) {
	s.roles = roles
	return s.hasResult, s.hasErr
}

func (s *stubPermissions) ForRoles(_ context.Context, _ []string) ([]string, error) {
	return s.forRoles, s.forErr
}

type stubTokens struct {
	gotUser  auth.Users
	gotRoles []string
	gotPerms []string
	gotTTL   time.Duration
	token    string
	err      error
}

func (s *stubTokens) IssueAccessWithTTL(user auth.Users, roles []string, permissions []string, ttl time.Duration) (string, error) {
	s.gotUser, s.gotRoles, s.gotPerms, s.gotTTL = user, roles, permissions, ttl
	if s.err != nil {
		return "", s.err
	}
	return s.token, nil
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func serve(h echo.HandlerFunc, method, target string, body io.Reader, identity auth.Identity, params map[string]string) *httptest.ResponseRecorder {
	e := echo.New()
	req := httptest.NewRequest(method, target, body)
	req = req.WithContext(auth.SetIdentity(req.Context(), identity))
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	if len(params) > 0 {
		// SetParamNames/SetParamValues each REPLACE the whole slice, so every
		// param must be set in one call — a loop calling them per key would
		// silently keep only the last one (harmless for pictures' single-:id
		// routes, a real bug for this package's two-param :name/:id route).
		names := make([]string, 0, len(params))
		values := make([]string, 0, len(params))
		for k, v := range params {
			names = append(names, k)
			values = append(values, v)
		}
		c.SetParamNames(names...)
		c.SetParamValues(values...)
	}
	if err := h(c); err != nil {
		e.HTTPErrorHandler(err, c)
	}
	return rec
}

func errorCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var payload struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode error envelope: %v (body: %s)", err, rec.Body.String())
	}
	return payload.Error.Code
}

// ── POST /reports/:name/:id/pdf ─────────────────────────────────────────────

func TestGeneratePDF_DeniesWithoutTheReportPermission(t *testing.T) {
	renderer := &stubRenderer{}
	objects := &stubObjects{}
	perms := &stubPermissions{hasResult: false}
	tokens := &stubTokens{}
	h := NewHandler(renderer, objects, tokens, perms, "http://core-front:3000")

	identity := auth.Identity{UserID: uuid.New(), TenantID: uuid.New(), Roles: []string{"viewer"}}
	rec := serve(h.GeneratePDF, "POST", "/api/v1/reports/crm.statement/123/pdf", nil, identity,
		map[string]string{"name": "crm.statement", "id": "123"})

	if rec.Code != 403 {
		t.Fatalf("expected 403, got %d: %s", rec.Code, rec.Body.String())
	}
	if errorCode(t, rec) != "FORBIDDEN" {
		t.Errorf("expected FORBIDDEN, got %s", rec.Body.String())
	}
	if renderer.gotURL != "" {
		t.Error("renderer must not be called when permission is denied")
	}
}

func TestGeneratePDF_ChecksTheReportSpecificPermission(t *testing.T) {
	renderer := &stubRenderer{pdf: []byte("%PDF-fake")}
	objects := &stubObjects{}
	perms := &stubPermissions{hasResult: true}
	tokens := &stubTokens{token: "signed-token"}
	h := NewHandler(renderer, objects, tokens, perms, "http://core-front:3000")

	identity := auth.Identity{UserID: uuid.New(), TenantID: uuid.New(), Roles: []string{"admin"}}
	serve(h.GeneratePDF, "POST", "/api/v1/reports/crm.statement/123/pdf", nil, identity,
		map[string]string{"name": "crm.statement", "id": "123"})

	// The permission checked must be scoped to THIS report, not a generic
	// "reports:reports:*" — see the handler's own doc comment on why the
	// generic PermissionMiddleware can't derive this.
	if len(perms.roles) == 0 {
		t.Fatal("permission check never ran")
	}
}

func TestGeneratePDF_MintsAShortLivedTokenScopedToTheCaller(t *testing.T) {
	renderer := &stubRenderer{pdf: []byte("%PDF-fake")}
	objects := &stubObjects{}
	perms := &stubPermissions{hasResult: true, forRoles: []string{"crm:crm:read"}}
	tokens := &stubTokens{token: "signed-token"}
	h := NewHandler(renderer, objects, tokens, perms, "http://core-front:3000")

	userID, tenantID := uuid.New(), uuid.New()
	identity := auth.Identity{UserID: userID, TenantID: tenantID, Roles: []string{"admin"}}
	serve(h.GeneratePDF, "POST", "/api/v1/reports/crm.statement/123/pdf", nil, identity,
		map[string]string{"name": "crm.statement", "id": "123"})

	if tokens.gotUser.ID != userID || tokens.gotUser.TenantID != tenantID {
		t.Errorf("token minted for the wrong identity: %+v", tokens.gotUser)
	}
	if tokens.gotTTL != printTokenTTL {
		t.Errorf("token TTL = %v, want the short-lived printTokenTTL (%v)", tokens.gotTTL, printTokenTTL)
	}
	if len(tokens.gotPerms) != 1 || tokens.gotPerms[0] != "crm:crm:read" {
		t.Errorf("token permissions must come from a FRESH ForRoles lookup, got %v", tokens.gotPerms)
	}
	// The print URL must carry the minted token, not the caller's own session.
	if !strings.Contains(renderer.gotURL, "token=signed-token") {
		t.Errorf("print URL missing the minted token: %s", renderer.gotURL)
	}
	if !strings.HasPrefix(renderer.gotURL, "http://core-front:3000/print/report/crm.statement/123?") {
		t.Errorf("unexpected print URL shape: %s", renderer.gotURL)
	}
}

func TestGeneratePDF_UploadsTheRenderedBytesAndReturnsADownloadURL(t *testing.T) {
	renderer := &stubRenderer{pdf: []byte("%PDF-real-bytes")}
	objects := &stubObjects{}
	perms := &stubPermissions{hasResult: true}
	tokens := &stubTokens{token: "t"}
	h := NewHandler(renderer, objects, tokens, perms, "http://core-front:3000")

	tenantID := uuid.New()
	identity := auth.Identity{UserID: uuid.New(), TenantID: tenantID, Roles: []string{"admin"}}
	rec := serve(h.GeneratePDF, "POST", "/api/v1/reports/crm.statement/123/pdf", nil, identity,
		map[string]string{"name": "crm.statement", "id": "123"})

	if rec.Code != 201 {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}
	if !bytes.Equal(objects.putData, renderer.pdf) {
		t.Errorf("uploaded bytes don't match the rendered PDF")
	}
	if !strings.HasPrefix(objects.putKey, "reports/"+tenantID.String()+"/crm.statement/123/") {
		t.Errorf("unexpected object key: %s", objects.putKey)
	}
	var payload struct {
		DownloadURL string `json:"download_url"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !strings.Contains(payload.DownloadURL, "key=") {
		t.Errorf("download_url missing the object key: %s", payload.DownloadURL)
	}
}

func TestGeneratePDF_SurfacesAPdfServiceFailureAsA502NotAPanic(t *testing.T) {
	renderer := &stubRenderer{err: errors.New("connection refused")}
	objects := &stubObjects{}
	perms := &stubPermissions{hasResult: true}
	tokens := &stubTokens{token: "t"}
	h := NewHandler(renderer, objects, tokens, perms, "http://core-front:3000")

	identity := auth.Identity{UserID: uuid.New(), TenantID: uuid.New(), Roles: []string{"admin"}}
	rec := serve(h.GeneratePDF, "POST", "/api/v1/reports/crm.statement/123/pdf", nil, identity,
		map[string]string{"name": "crm.statement", "id": "123"})

	if rec.Code != 502 {
		t.Fatalf("expected 502, got %d: %s", rec.Code, rec.Body.String())
	}
	if errorCode(t, rec) != "RENDER_FAILED" {
		t.Errorf("expected RENDER_FAILED, got %s", rec.Body.String())
	}
}

// ── GET /reports/pdf ─────────────────────────────────────────────────────────

func TestDownloadPDF_StreamsAKeyBelongingToTheCallersTenant(t *testing.T) {
	tenantID := uuid.New()
	objects := &stubObjects{getBody: "%PDF-content"}
	h := NewHandler(&stubRenderer{}, objects, &stubTokens{}, &stubPermissions{}, "http://core-front:3000")

	identity := auth.Identity{UserID: uuid.New(), TenantID: tenantID}
	key := "reports/" + tenantID.String() + "/crm.statement/123/1700000000.pdf"
	rec := serve(h.DownloadPDF, "GET", "/api/v1/reports/pdf?key="+key, nil, identity, nil)

	if rec.Code != 200 {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if rec.Body.String() != "%PDF-content" {
		t.Errorf("unexpected body: %s", rec.Body.String())
	}
}

func TestDownloadPDF_RejectsAKeyBelongingToAnotherTenant(t *testing.T) {
	objects := &stubObjects{getBody: "%PDF-content"}
	h := NewHandler(&stubRenderer{}, objects, &stubTokens{}, &stubPermissions{}, "http://core-front:3000")

	identity := auth.Identity{UserID: uuid.New(), TenantID: uuid.New()}
	otherTenantKey := "reports/" + uuid.New().String() + "/crm.statement/123/1700000000.pdf"
	rec := serve(h.DownloadPDF, "GET", "/api/v1/reports/pdf?key="+otherTenantKey, nil, identity, nil)

	if rec.Code != 404 {
		t.Fatalf("expected 404 (tenant isolation), got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestDownloadPDF_404sOnAMissingKeyInsteadOfLeakingTheStorageError(t *testing.T) {
	tenantID := uuid.New()
	objects := &stubObjects{getErr: errors.New("NoSuchKey")}
	h := NewHandler(&stubRenderer{}, objects, &stubTokens{}, &stubPermissions{}, "http://core-front:3000")

	identity := auth.Identity{UserID: uuid.New(), TenantID: tenantID}
	key := "reports/" + tenantID.String() + "/crm.statement/123/1700000000.pdf"
	rec := serve(h.DownloadPDF, "GET", "/api/v1/reports/pdf?key="+key, nil, identity, nil)

	if rec.Code != 404 {
		t.Fatalf("expected 404, got %d: %s", rec.Code, rec.Body.String())
	}
}
