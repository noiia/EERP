package office

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

const maxDocumentBytes = 20 << 20

// resultURL accepts only the configured DocumentServer cache, with redirects
// disabled. The URL is taken from the verified outbox JWT, never unsigned JSON.
func (s *Service) resultURL(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.Fragment != "" {
		return nil, fmt.Errorf("office: invalid result URL")
	}
	var base *url.URL
	for _, candidate := range []*url.URL{s.public, s.internal} {
		if u.Scheme == candidate.Scheme && u.Host == candidate.Host && strings.HasPrefix(u.Path, candidate.Path+"/cache/files/") {
			base = candidate
			break
		}
	}
	if base == nil || strings.Contains(u.Path, "..") || strings.ContainsAny(u.Path, "\\\x00") {
		return nil, fmt.Errorf("office: untrusted result URL")
	}
	u.Path = s.internal.Path + strings.TrimPrefix(u.Path, base.Path)
	u.RawPath = ""
	u.Scheme, u.Host = s.internal.Scheme, s.internal.Host
	return u, nil
}

func (s *Service) Callback(c *echo.Context) error {
	grant, ok, err := s.authorize(c, "callback")
	if !ok {
		return err
	}
	// The scoped URL proves which editor may save; the outbox JWT independently
	// proves the save notification and download URL came from DocumentServer.
	raw := strings.TrimPrefix(c.Request().Header.Get("Authorization"), "Bearer ")
	claims := jwt.MapClaims{}
	_, err = jwt.ParseWithClaims(raw, claims, func(*jwt.Token) (any, error) { return s.secret, nil }, jwt.WithValidMethods([]string{"HS256"}))
	if err != nil {
		return replyError(c, 401, "UNAUTHENTICATED", "Invalid Euro-Office signature.")
	}
	var payload any = claims
	if nested, exists := claims["payload"]; exists {
		payload = nested
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	var event struct {
		Key    string `json:"key"`
		Status int    `json:"status"`
		URL    string `json:"url"`
	}
	if json.Unmarshal(data, &event) != nil || event.Key != grant.Key {
		return replyError(c, 401, "UNAUTHENTICATED", "Invalid document session.")
	}
	ack := func(success bool) error {
		code := 1
		if success {
			code = 0
		}
		return c.JSON(http.StatusOK, map[string]int{"error": code})
	}
	source, doc, ok, err := s.resolve(c)
	if !ok {
		return err
	}
	if event.Status == 1 || event.Status == 4 {
		return ack(true)
	}
	// With forcesave disabled, status 2 is the final snapshot after the last
	// editor leaves. All collaborators retain the same key until that save.
	if event.Status != 2 || !doc.Writable || source.Replace == nil {
		return ack(false)
	}
	_, editable := FileType(doc.Name)
	if !editable {
		return ack(false)
	}
	prefix := fmt.Sprintf("%s/office/%s/%s/", grant.Tenant, doc.ID, grant.Key)
	// A repeated final callback is successful even if its first acknowledgement
	// was lost. Random suffixes keep losing CAS writers from deleting a winner.
	if strings.HasPrefix(doc.ObjectKey, prefix) {
		return ack(true)
	}
	if Version(doc.ObjectKey) != grant.Key {
		return ack(false)
	}
	u, err := s.resultURL(event.URL)
	if err != nil {
		return ack(false)
	}
	request, err := http.NewRequestWithContext(c.Request().Context(), http.MethodGet, u.String(), nil)
	if err != nil {
		return err
	}
	response, err := s.client.Do(request)
	if err != nil {
		return ack(false)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return ack(false)
	}
	content, err := io.ReadAll(io.LimitReader(response.Body, maxDocumentBytes+1))
	if err != nil || len(content) == 0 || len(content) > maxDocumentBytes {
		return ack(false)
	}
	// Office documents are ZIP packages. Refuse a proxy/login/error HTML page.
	if len(content) < 4 || !bytes.Equal(content[:4], []byte{'P', 'K', 3, 4}) {
		return ack(false)
	}
	key := prefix + uuid.NewString()
	ctx := c.Request().Context()
	if err := s.objects.Put(ctx, key, doc.Mime, int64(len(content)), bytes.NewReader(content)); err != nil {
		return ack(false)
	}
	replaced, err := source.Replace(c, doc, key, int64(len(content)))
	if err != nil || !replaced {
		_ = s.objects.Delete(ctx, key)
		return ack(false)
	}
	// Once the metadata points to the new object, an old object cleanup failure
	// must never turn a durable save into a reported failure.
	_ = s.objects.Delete(ctx, doc.ObjectKey)
	return ack(true)
}
