// Package office connects EERP's authorized file stores to Euro-Office's
// DocumentServer API. EERP remains the owner of storage and access control.
package office

import (
	"context"
	"crypto/sha256"
	"fmt"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"time"

	"core/internal/auth"
	"core/internal/pictures"
	"core/internal/types"
	"core/orm/access"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

// Document contains private storage metadata. It is never serialized to clients.
type Document struct {
	ID                    uuid.UUID
	Name, Mime, ObjectKey string
	Size                  int64
	Writable              bool
}

// Source must authorize every resolution against the current identity, including
// callbacks. Replace atomically compares previous.ObjectKey before swapping bytes.
type Source struct {
	Resolve func(*echo.Context, uuid.UUID) (Document, bool, error)
	Replace func(*echo.Context, Document, string, int64) (bool, error)
}

type Users interface {
	FindByID(context.Context, uuid.UUID) (auth.Users, error)
	FindRoleNames(context.Context, uuid.UUID) ([]string, error)
	FindGroups(context.Context, uuid.UUID) ([]string, error)
}

type Service struct {
	public, internal, storage *url.URL
	secret                    []byte
	objects                   pictures.ObjectStore
	users                     Users
	sources                   map[string]Source
	client                    *http.Client
}

func baseURL(raw string) (*url.URL, error) {
	u, err := url.Parse(strings.TrimRight(raw, "/"))
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, fmt.Errorf("office: invalid server URL")
	}
	return u, nil
}

func New(cfg *types.Config, objects pictures.ObjectStore, users Users) (*Service, error) {
	s := &Service{objects: objects, users: users, sources: map[string]Source{}, client: &http.Client{
		Timeout:       60 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}
	if cfg.EuroOfficeJWTSecret == "" {
		return s, nil
	}
	if len(cfg.EuroOfficeJWTSecret) < 32 {
		return nil, fmt.Errorf("office: euro_office_jwt_secret must be at least 32 characters")
	}
	var err error
	if s.public, err = baseURL(cfg.EuroOfficeURL); err != nil {
		return nil, err
	}
	internal := cfg.EuroOfficeInternalURL
	if internal == "" {
		internal = cfg.EuroOfficeURL
	}
	if s.internal, err = baseURL(internal); err != nil {
		return nil, err
	}
	if s.storage, err = baseURL(cfg.EuroOfficeStorageURL); err != nil {
		return nil, err
	}
	s.secret = []byte(cfg.EuroOfficeJWTSecret)
	return s, nil
}

func (s *Service) Register(name string, source Source) { s.sources[name] = source }

func Version(key string) string { return fmt.Sprintf("%x", sha256.Sum256([]byte(key))) }

func FileType(name string) (kind string, editable bool) {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".docx":
		return "word", true
	case ".xlsx":
		return "cell", true
	case ".pptx":
		return "slide", true
	case ".doc", ".odt", ".rtf", ".txt":
		return "word", false
	case ".xls", ".ods", ".csv":
		return "cell", false
	case ".ppt", ".odp":
		return "slide", false
	case ".pdf":
		return "pdf", false
	case ".vsdx":
		return "diagram", false
	default:
		return "", false
	}
}

func replyError(c *echo.Context, status int, code, message string) error {
	return c.JSON(status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}

func (s *Service) resolve(c *echo.Context) (Source, Document, bool, error) {
	if s.public == nil || s.objects == nil {
		return Source{}, Document{}, false, replyError(c, 503, "OFFICE_UNAVAILABLE", "Euro-Office is not configured.")
	}
	source, exists := s.sources[c.Param("source")]
	id, err := uuid.Parse(c.Param("id"))
	if !exists || source.Resolve == nil || err != nil {
		return Source{}, Document{}, false, replyError(c, 404, "NOT_FOUND", "No such document.")
	}
	doc, ok, err := source.Resolve(c, id)
	return source, doc, ok, err
}

// Mount keeps editor configuration behind ERP authentication. Only narrowly
// scoped signed URLs reach the two server-to-server endpoints.
func (s *Service) Mount(g *echo.Group, authenticated echo.MiddlewareFunc) {
	g.GET("/:source/:id/session", s.Session, authenticated)
	g.GET("/:source/:id/content", s.Content)
	g.POST("/:source/:id/callback", s.Callback)
}

type grant struct {
	Purpose string    `json:"purpose"`
	Source  string    `json:"source"`
	File    uuid.UUID `json:"file"`
	Tenant  uuid.UUID `json:"tenant"`
	User    uuid.UUID `json:"user"`
	Key     string    `json:"key"`
	jwt.RegisteredClaims
}

func (s *Service) signedURL(c *echo.Context, doc Document, purpose string) (string, error) {
	id := auth.MustIdentity(c.Request().Context())
	g := grant{Purpose: purpose, Source: c.Param("source"), File: doc.ID, Tenant: id.TenantID, User: id.UserID, Key: Version(doc.ObjectKey),
		RegisteredClaims: jwt.RegisteredClaims{ExpiresAt: jwt.NewNumericDate(time.Now().Add(24 * time.Hour)), Audience: jwt.ClaimStrings{"eerp-office"}}}
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, g).SignedString(s.secret)
	if err != nil {
		return "", err
	}
	u := *s.storage
	u.Path += "/api/v1/office/" + g.Source + "/" + doc.ID.String() + "/" + purpose
	u.RawQuery = url.Values{"access_token": {token}}.Encode()
	return u.String(), nil
}

func (s *Service) authorize(c *echo.Context, purpose string) (*grant, bool, error) {
	if s.public == nil {
		return nil, false, replyError(c, 503, "OFFICE_UNAVAILABLE", "Euro-Office is not configured.")
	}
	g := &grant{}
	_, err := jwt.ParseWithClaims(c.QueryParam("access_token"), g, func(*jwt.Token) (any, error) { return s.secret, nil }, jwt.WithValidMethods([]string{"HS256"}), jwt.WithAudience("eerp-office"), jwt.WithExpirationRequired())
	if err != nil || g.Purpose != purpose || g.Source != c.Param("source") || g.File.String() != c.Param("id") {
		return nil, false, replyError(c, 401, "UNAUTHENTICATED", "Invalid document access.")
	}
	u, err := s.users.FindByID(c.Request().Context(), g.User)
	if err != nil || u.TenantID != g.Tenant || u.IsWebsite() {
		return nil, false, replyError(c, 401, "UNAUTHENTICATED", "Invalid document access.")
	}
	roles, err := s.users.FindRoleNames(c.Request().Context(), u.ID)
	if err != nil {
		return nil, false, err
	}
	groups, err := s.users.FindGroups(c.Request().Context(), u.ID)
	if err != nil {
		return nil, false, err
	}
	id := auth.Identity{UserID: u.ID, TenantID: u.TenantID, Roles: roles, Groups: groups, MustChangePassword: u.MustChangePassword}
	ctx := access.WithGroups(access.WithTenant(auth.SetIdentity(c.Request().Context(), id), id.TenantID), groups)
	c.SetRequest(c.Request().WithContext(ctx))
	return g, true, nil
}
