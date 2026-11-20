package office

import (
	"mime"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"core/internal/auth"

	"github.com/golang-jwt/jwt/v5"
	"github.com/labstack/echo/v5"
)

func (s *Service) Session(c *echo.Context) error {
	source, doc, ok, err := s.resolve(c)
	if !ok {
		return err
	}
	kind, editable := FileType(doc.Name)
	if kind == "" {
		return replyError(c, 422, "VALIDATION_ERROR", "This file type cannot be opened in Euro-Office.")
	}
	identity := auth.MustIdentity(c.Request().Context())
	user, err := s.users.FindByID(c.Request().Context(), identity.UserID)
	if err != nil {
		return err
	}
	if user.ID != identity.UserID || user.TenantID != identity.TenantID || user.IsWebsite() {
		return replyError(c, http.StatusUnauthorized, "UNAUTHENTICATED", "Invalid user session.")
	}
	editable = editable && doc.Writable && source.Replace != nil && !identity.MustChangePassword
	contentURL, err := s.signedURL(c, doc, "content")
	if err != nil {
		return err
	}
	mode := "view"
	if editable {
		mode = "edit"
	}
	profile := collaborationUser(user)
	if user.Avatar != nil && *user.Avatar {
		avatar := *s.public
		avatar.Path = "/api/avatars/" + user.ID.String()
		profile["image"] = avatar.String()
	}
	editor := map[string]any{"mode": mode, "lang": "en", "user": profile,
		"coEditing":     map[string]any{"mode": "fast", "change": true},
		"customization": map[string]any{"autosave": true, "forcesave": false, "compactHeader": true, "help": false, "goback": map[string]bool{"requestClose": true}}}
	if lang := c.QueryParam("lang"); lang == "fr" || lang == "en" {
		editor["lang"] = lang
	}
	if editable {
		editor["plugins"] = map[string]any{"pluginsData": []string{s.public.String() + "/sdkjs-plugins/erp-diagrams/config.json"}}
		callback, err := s.signedURL(c, doc, "callback")
		if err != nil {
			return err
		}
		editor["callbackUrl"] = callback
	}
	config := map[string]any{"type": "desktop", "width": "100%", "height": "100%", "documentType": kind,
		"document": map[string]any{"title": doc.Name, "fileType": strings.TrimPrefix(strings.ToLower(filepath.Ext(doc.Name)), "."), "key": Version(doc.ObjectKey), "url": contentURL,
			"permissions": map[string]bool{"edit": editable, "review": editable, "comment": editable, "fillForms": editable, "download": true, "print": true}}, "editorConfig": editor}
	claims := jwt.MapClaims{}
	for key, value := range config {
		claims[key] = value
	}
	// Captured editor configurations must not remain reusable indefinitely.
	claims["exp"] = time.Now().Add(5 * time.Minute).Unix()
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(s.secret)
	if err != nil {
		return err
	}
	config["token"] = token
	c.Response().Header().Set("Cache-Control", "private, no-store")
	return c.JSON(http.StatusOK, map[string]any{"apiUrl": s.public.String() + "/web-apps/apps/api/documents/api.js", "config": config, "editable": editable})
}

// The server-owned profile supplies stable attribution for comments and edits,
// including accounts whose optional display_name has never been set.
func collaborationUser(user auth.Users) map[string]string {
	name := strings.TrimSpace(user.DisplayName)
	if name == "" {
		name = strings.Join(strings.Fields(user.Name+" "+user.Surname), " ")
	}
	if name == "" && user.Username != nil {
		name = strings.TrimSpace(*user.Username)
	}
	if name == "" {
		name = strings.TrimSpace(user.Email)
	}
	if name == "" {
		name = user.ID.String()
	}
	return map[string]string{"id": user.ID.String(), "name": name}
}

func (s *Service) Content(c *echo.Context) error {
	grant, ok, err := s.authorize(c, "content")
	if !ok {
		return err
	}
	_, doc, ok, err := s.resolve(c)
	if !ok {
		return err
	}
	if Version(doc.ObjectKey) != grant.Key {
		return replyError(c, 409, "CONFLICT", "This document has changed. Reopen it.")
	}
	body, contentType, err := s.objects.Get(c.Request().Context(), doc.ObjectKey)
	if err != nil {
		return err
	}
	defer body.Close()
	if doc.Mime != "" {
		contentType = doc.Mime
	}
	c.Response().Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": doc.Name}))
	c.Response().Header().Set("Cache-Control", "private, no-store")
	return c.Stream(http.StatusOK, contentType, body)
}
