package mcpbridge

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"core/internal/auth"
	"core/orm/server"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
	"go.uber.org/zap"
)

const (
	Path             = "/api/v1/mcp"
	maxResponseBytes = 4 << 20
	maxRequestBytes  = 1 << 20
	operationTimeout = 30 * time.Second
)

type permissionChecker interface {
	Has(context.Context, []string, string) (bool, error)
}

// Operation is an exact method + router pattern, never a caller-supplied URL.
type Operation struct {
	ID       string `json:"id"`
	Method   string `json:"method"`
	Path     string `json:"path"`
	ReadOnly bool   `json:"read_only"`
}

// Bridge is immutable after construction and safe for concurrent callers.
type Bridge struct {
	api         http.Handler
	router      *echo.Echo
	operations  map[string]Operation
	models      func(context.Context) []server.APIModel
	perms       permissionChecker
	isActive    func(string) bool
	allowWrites bool
	logger      *zap.Logger
	slots       chan struct{}
}

// New snapshots routes after all business overrides have been mounted. Only
// registered CRUD models and explicitly reviewed staff API roots are admitted;
// anonymous routes, authentication, webhooks and DB management stay out.
func New(e *echo.Echo, perms permissionChecker, isActive func(string) bool, allowWrites bool, logger *zap.Logger) *Bridge {
	b := &Bridge{api: e, router: e, operations: map[string]Operation{}, models: server.ModelCatalog,
		perms: perms, isActive: isActive, allowWrites: allowWrites, logger: logger, slots: make(chan struct{}, 16)}
	roots := map[string]bool{}
	for _, m := range server.ModelCatalog(context.Background()) {
		roots[m.Route] = true
	}
	for _, root := range []string{"me", "settings", "company", "pictures", "avatars", "attachments", "reports",
		"notebook_pages", "saved_filters", "mail_outbox", "graph_fields", "notifications", "chatter_messages",
		"teams", "presence", "cron_history", "modules", "views", "users", "roles", "website_admin", "geo", "versions"} {
		roots[root] = true
	}
	for _, r := range e.Router().Routes() {
		if !strings.HasPrefix(r.Path, "/api/v1/") || strings.Contains(r.Path, "*") {
			continue
		}
		root, _, _ := strings.Cut(strings.TrimPrefix(r.Path, "/api/v1/"), "/")
		// Reserved roots stay excluded even if an API alias or future model
		// accidentally shares their name. In particular MCP cannot call itself.
		if slices.Contains([]string{"mcp", "auth", "public", "website", "calendar", "database-management", "dev_seed"}, root) {
			continue
		}
		if !roots[root] || !slices.Contains([]string{"GET", "POST", "PUT", "PATCH", "DELETE"}, r.Method) {
			continue
		}
		op := Operation{ID: r.Method + " " + r.Path, Method: r.Method, Path: r.Path, ReadOnly: r.Method == http.MethodGet}
		b.operations[op.ID] = op
	}
	return b
}

type callerKey struct{}
type caller struct{ authorization, remoteAddr string }

func validIdentity(id auth.Identity) bool { return id.UserID != uuid.Nil && id.TenantID != uuid.Nil }

// Request contains only API arguments, with no URL, headers, credentials or SQL.
type Request struct {
	Operation  string            `json:"operation" jsonschema:"Exact operation id from eerp_list_operations, for example GET /api/v1/project/:id/metrics"`
	PathParams map[string]string `json:"path_params,omitempty" jsonschema:"Values for every named path parameter"`
	Query      map[string]string `json:"query,omitempty" jsonschema:"API query parameters, including page, page_size, order, filter[column], search[column] and in[column]"`
	Body       map[string]any    `json:"body,omitempty" jsonschema:"JSON object accepted by the business endpoint; consult model schema and documentation"`
	Form       map[string]string `json:"form,omitempty" jsonschema:"Multipart form fields; use instead of body for uploads"`
	Files      []Upload          `json:"files,omitempty" jsonschema:"Base64 encoded multipart files; subject to the MCP request size limit"`
}

type Upload struct {
	Field    string `json:"field"`
	Name     string `json:"name"`
	MIMEType string `json:"mime_type"`
	Base64   string `json:"base64"`
}

// Response preserves API status/envelopes. Binary bodies are base64 encoded.
type Response struct {
	Status   int    `json:"status"`
	Data     any    `json:"data,omitempty"`
	MIMEType string `json:"mime_type,omitempty"`
	Base64   string `json:"base64,omitempty"`
}

func (b *Bridge) catalog(search string) []Operation {
	ops := []Operation{}
	for _, op := range b.operations {
		if (!b.allowWrites && !op.ReadOnly) || !strings.Contains(strings.ToLower(op.ID), strings.ToLower(search)) {
			continue
		}
		ops = append(ops, op)
	}
	sort.Slice(ops, func(i, j int) bool { return ops[i].ID < ops[j].ID })
	return ops
}

func (b *Bridge) visibleModels(ctx context.Context) ([]server.APIModel, error) {
	id, ok := auth.IdentityFromContext(ctx)
	if !ok || !validIdentity(id) || id.MustChangePassword {
		return nil, errors.New("ERP authentication and a completed password change are required")
	}
	out := []server.APIModel{}
	for _, m := range b.models(ctx) {
		if b.isActive != nil && !b.isActive(m.Name) {
			continue
		}
		ok, err := b.perms.Has(ctx, id.Roles, m.Route+":"+m.Route+":read")
		if err != nil {
			return nil, errors.New("unable to check model permissions")
		}
		if ok {
			out = append(out, m)
		}
	}
	return out, nil
}

func (b *Bridge) model(ctx context.Context, name string) (server.APIModel, error) {
	models, err := b.visibleModels(ctx)
	if err != nil {
		return server.APIModel{}, err
	}
	for _, m := range models {
		if m.Name == name {
			return m, nil
		}
	}
	return server.APIModel{}, errors.New("model unavailable or read permission denied")
}

func (b *Bridge) execute(ctx context.Context, input Request, write bool) (Response, error) {
	op, ok := b.operations[input.Operation]
	if !ok {
		return Response{}, errors.New("unknown operation; use eerp_list_operations")
	}
	if !op.ReadOnly && (!b.allowWrites || !write) {
		return Response{}, errors.New("writes are disabled or require a mutation tool")
	}
	if op.ReadOnly && write {
		return Response{}, errors.New("use eerp_read_operation for GET operations")
	}
	if op.ReadOnly && (input.Body != nil || input.Form != nil || len(input.Files) > 0) {
		return Response{}, errors.New("GET operations do not accept a body")
	}
	id, authenticated := auth.IdentityFromContext(ctx)
	c, hasCaller := ctx.Value(callerKey{}).(caller)
	if !authenticated || !validIdentity(id) || !hasCaller || c.authorization == "" || id.MustChangePassword {
		return Response{}, errors.New("ERP authentication and a completed password change are required")
	}
	select {
	case b.slots <- struct{}{}:
		defer func() { <-b.slots }()
	default:
		return Response{}, errors.New("MCP is busy; this operation was not started")
	}
	path, err := resolvePath(op.Path, input.PathParams)
	if err != nil {
		return Response{}, err
	}
	query := url.Values{}
	for k, v := range input.Query {
		if k == "page_size" {
			n, err := strconv.Atoi(v)
			if err != nil || n < 1 || n > 200 {
				return Response{}, errors.New("page_size must be between 1 and 200 for MCP operations")
			}
		}
		query.Set(k, v)
	}
	if len(query.Encode()) > 16<<10 {
		return Response{}, errors.New("query is too large")
	}
	if len(query) > 0 {
		path += "?" + query.Encode()
	}
	body, contentType, err := requestBody(input)
	if err != nil {
		return Response{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, operationTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, op.Method, path, bytes.NewReader(body))
	if err != nil {
		return Response{}, errors.New("invalid API request")
	}
	req.Header.Set("Authorization", c.authorization)
	req.Header.Set("Content-Type", contentType)
	req.RemoteAddr = c.remoteAddr
	// A fresh request deliberately drops Cookie, forwarded headers, MCP headers
	// and Upgrade. In particular, the presence route can only return its snapshot.
	rec := &boundedResponse{header: make(http.Header)}
	// A parameter such as "directory" must not select a different static route
	// than the operation the client requested.
	matched := b.router.NewContext(req, rec)
	b.router.Router().Route(matched)
	if matched.Path() != op.Path {
		return Response{}, errors.New("path parameters resolve to a different operation")
	}
	if ctx.Err() != nil {
		return Response{}, errors.New("request cancelled; this operation was not started")
	}
	start := time.Now()
	b.api.ServeHTTP(rec, req)
	if b.logger != nil {
		b.logger.Info("mcp operation", zap.String("operation", op.ID), zap.String("user_id", id.UserID.String()),
			zap.String("tenant_id", id.TenantID.String()), zap.Int("status", rec.status), zap.Duration("duration", time.Since(start)))
	}
	if rec.overflow {
		return Response{}, errors.New("API response exceeds 4 MiB; narrow the query or reduce page_size. A mutation may already have completed; check its state before retrying")
	}
	if ctx.Err() != nil {
		return Response{}, errors.New("API operation timed out or was cancelled; check mutation state before retrying")
	}
	response := Response{Status: rec.status}
	if response.Status == 0 {
		response.Status = http.StatusOK
	}
	if response.Status >= 500 {
		return response, errors.New("EERP could not complete the operation; consult server logs")
	}
	if response.Status >= 300 && response.Status < 400 {
		return response, errors.New("API redirects are not followed")
	}
	if rec.body.Len() > 0 {
		if json.Valid(rec.body.Bytes()) {
			dec := json.NewDecoder(&rec.body)
			dec.UseNumber()
			if err := dec.Decode(&response.Data); err != nil {
				return Response{}, errors.New("invalid API JSON response")
			}
		} else {
			response.MIMEType = rec.header.Get("Content-Type")
			response.Base64 = base64.StdEncoding.EncodeToString(rec.body.Bytes())
		}
	}
	return response, nil
}

func resolvePath(pattern string, params map[string]string) (string, error) {
	parts := strings.Split(pattern, "/")
	used := 0
	for i, part := range parts {
		if !strings.HasPrefix(part, ":") {
			continue
		}
		value, ok := params[strings.TrimPrefix(part, ":")]
		if !ok || !validSegment(value) {
			return "", fmt.Errorf("missing or invalid path parameter %s", part)
		}
		parts[i] = url.PathEscape(value)
		used++
	}
	if used != len(params) {
		return "", errors.New("unexpected path parameter")
	}
	return strings.Join(parts, "/"), nil
}

func validSegment(s string) bool {
	if s == "" || s == "." || s == ".." || len(s) > 256 {
		return false
	}
	for _, r := range s {
		if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || strings.ContainsRune("_.-:@", r)) {
			return false
		}
	}
	return true
}

func requestBody(input Request) ([]byte, string, error) {
	if input.Form == nil && len(input.Files) == 0 {
		if input.Body == nil {
			return nil, "application/json", nil
		}
		body, err := json.Marshal(input.Body)
		if err != nil || len(body) > maxRequestBytes {
			return nil, "", errors.New("invalid or oversized JSON body")
		}
		return body, "application/json", nil
	}
	if input.Body != nil {
		return nil, "", errors.New("body and multipart fields are mutually exclusive")
	}
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	for k, v := range input.Form {
		if !validFormField(k) {
			return nil, "", errors.New("invalid multipart field name")
		}
		if len(k)+len(v)+body.Len() > maxRequestBytes {
			return nil, "", errors.New("multipart body exceeds 1 MiB")
		}
		if err := w.WriteField(k, v); err != nil {
			return nil, "", err
		}
	}
	for _, f := range input.Files {
		if !validFormField(f.Field) || !validFilename(f.Name) || len(f.Base64) > 2*maxRequestBytes {
			return nil, "", errors.New("invalid or oversized upload")
		}
		if _, _, err := mime.ParseMediaType(f.MIMEType); err != nil {
			return nil, "", errors.New("invalid upload MIME type")
		}
		data, err := base64.StdEncoding.Strict().DecodeString(f.Base64)
		if err != nil || len(data)+body.Len() > maxRequestBytes {
			return nil, "", errors.New("invalid base64 or multipart body exceeds 1 MiB")
		}
		h := make(textproto.MIMEHeader)
		h.Set("Content-Disposition", mime.FormatMediaType("form-data", map[string]string{"name": f.Field, "filename": f.Name}))
		h.Set("Content-Type", f.MIMEType)
		part, err := w.CreatePart(h)
		if err != nil {
			return nil, "", err
		}
		if _, err := part.Write(data); err != nil {
			return nil, "", err
		}
	}
	if err := w.Close(); err != nil {
		return nil, "", err
	}
	if body.Len() > maxRequestBytes {
		return nil, "", errors.New("multipart body exceeds 1 MiB")
	}
	return body.Bytes(), w.FormDataContentType(), nil
}

func validFilename(name string) bool {
	if name == "" || name == "." || name == ".." || len(name) > 255 {
		return false
	}
	for _, r := range name {
		if r < 32 || r == 127 || r == '/' || r == '\\' {
			return false
		}
	}
	return true
}

func validFormField(name string) bool {
	if name == "" || len(name) > 128 {
		return false
	}
	for _, r := range name {
		if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || strings.ContainsRune("_.-[]", r)) {
			return false
		}
	}
	return true
}

type boundedResponse struct {
	header   http.Header
	status   int
	body     bytes.Buffer
	overflow bool
}

func (w *boundedResponse) Header() http.Header { return w.header }
func (w *boundedResponse) WriteHeader(code int) {
	if w.status == 0 {
		w.status = code
	}
}
func (w *boundedResponse) Write(p []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	if len(p) > maxResponseBytes-w.body.Len() {
		w.overflow = true
		return 0, errors.New("MCP response limit exceeded")
	}
	return w.body.Write(p)
}
