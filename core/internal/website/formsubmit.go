package website

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"net/mail"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"core/internal/auth"
	"core/internal/chatter"
	"core/internal/website/formtarget"
	"core/modules/contact"
	"core/orm"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

// Value limits of a form submission (characters).
const (
	maxTextLen  = 2000
	maxLongLen  = 10000
	maxPhoneLen = 50
	maxEmailLen = 254
	maxAddrLen  = 200
)

type formUsers interface {
	FindByID(ctx context.Context, id uuid.UUID) (auth.Users, error)
}

// FormHandler serves the website Form block (ADR-033): a submission is
// written into the tables the form's STORED, published definition names —
// never anything the request says — and only into columns a module
// registered with formtarget.RegisterFormTarget.
type FormHandler struct {
	db       *orm.DB
	tenant   uuid.UUID
	isActive func(table string) bool
	users    formUsers
}

// NewFormHandler wires the form endpoints. isActive is the module runtime's
// table gate (a deactivated module's table is never written).
func NewFormHandler(db *orm.DB, tenant uuid.UUID, isActive func(table string) bool, users formUsers) *FormHandler {
	return &FormHandler{db: db, tenant: tenant, isActive: isActive, users: users}
}

// formFieldError is a submitted value the form refuses.
type formFieldError struct{ ids []string }

func (e *formFieldError) Error() string { return "invalid form values" }

// errFormUnusable means the stored form can't be submitted right now
// (inactive target, or a fixed value its column can't hold).
var errFormUnusable = errors.New("website: this form can't be submitted")

func formValidationJSON(c *echo.Context, message string, fields []string) error {
	if fields == nil {
		fields = []string{}
	}
	return c.JSON(http.StatusUnprocessableEntity, map[string]any{
		"error": map[string]any{
			"code":       "VALIDATION_ERROR",
			"message":    message,
			"request_id": c.Response().Header().Get(echo.HeaderXRequestID),
			"fields":     fields,
		},
	})
}

// loadForm returns the published page's title and the form block's config;
// any miss (unpublished, unknown, other tenant, no such block, not a form,
// unreadable config) is orm.ErrNotFound.
func (h *FormHandler) loadForm(ctx context.Context, pageID uuid.UUID, blockID string) (string, formtarget.FormConfig, error) {
	var title string
	var layout []byte
	err := h.db.QueryRow(ctx, `SELECT title, layout FROM website_page
		WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL AND published IS TRUE`, pageID, h.tenant).Scan(&title, &layout)
	if err != nil {
		return "", formtarget.FormConfig{}, err
	}
	var blocks []struct {
		ID     string          `json:"id"`
		Type   string          `json:"type"`
		Config json.RawMessage `json:"config"`
	}
	if len(layout) > 0 {
		if err := json.Unmarshal(layout, &blocks); err != nil {
			return "", formtarget.FormConfig{}, orm.ErrNotFound
		}
	}
	for _, b := range blocks {
		if b.ID != blockID {
			continue
		}
		if b.Type != "form" {
			return "", formtarget.FormConfig{}, orm.ErrNotFound
		}
		var cfg formtarget.FormConfig
		if err := json.Unmarshal(b.Config, &cfg); err != nil {
			return "", formtarget.FormConfig{}, orm.ErrNotFound
		}
		return title, cfg, nil
	}
	return "", formtarget.FormConfig{}, orm.ErrNotFound
}

// Submit handles POST /api/v1/website/forms/:page_id/:block_id — anonymous or
// signed-in website visitor, body {values: {<field id>: value}}.
func (h *FormHandler) Submit(c *echo.Context) error {
	ctx := c.Request().Context()
	pageID, err := uuid.Parse(c.Param("page_id"))
	if err != nil || !h.isActive("website_page") {
		return echo.NewHTTPError(http.StatusNotFound, "not found")
	}
	title, cfg, err := h.loadForm(ctx, pageID, c.Param("block_id"))
	if errors.Is(err, orm.ErrNotFound) {
		return echo.NewHTTPError(http.StatusNotFound, "not found")
	}
	if err != nil {
		return err
	}
	// The stored layout was validated at save time, but the registry may have
	// changed since (a module dropped a column): check again before writing.
	if err := formtarget.ValidateFormConfig(cfg); err != nil {
		return formValidationJSON(c, "This form is no longer valid.", nil)
	}
	for _, t := range cfg.Targets {
		if !h.isActive(t.Table) {
			return formValidationJSON(c, "This form is not available.", nil)
		}
	}

	var visitor *auth.Users
	if id, ok := auth.IdentityFromContext(ctx); ok {
		u, err := h.users.FindByID(ctx, id.UserID)
		if err != nil || id.TenantID != h.tenant || u.TenantID != h.tenant || !u.IsWebsite() {
			return echo.NewHTTPError(http.StatusUnauthorized, "unauthenticated")
		}
		visitor = &u
	}
	if cfg.LoginRequired && visitor == nil {
		return echo.NewHTTPError(http.StatusUnauthorized, "login required")
	}

	var in struct {
		Values map[string]json.RawMessage `json:"values"`
	}
	if err := json.NewDecoder(c.Request().Body).Decode(&in); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "malformed body")
	}
	sub, err := parseSubmission(cfg, in.Values, orm.ColumnGoType)
	var fe *formFieldError
	if errors.As(err, &fe) {
		return formValidationJSON(c, "Some values are missing or invalid.", fe.ids)
	}
	if err != nil {
		return formValidationJSON(c, "This form is not available.", nil)
	}

	err = orm.Transact(ctx, h.db, func(tx *orm.Tx) error {
		return h.write(ctx, tx, title, cfg, sub, visitor)
	})
	if errors.Is(err, errFormUnusable) {
		return formValidationJSON(c, "This form is not available.", nil)
	}
	if err != nil {
		return err
	}
	return c.JSON(http.StatusCreated, map[string]any{"ok": true})
}

// submission is a parsed, validated form: per target, the column values to
// write (fields + fixed; links are resolved while writing), and the
// human-readable "label: value" lines of each target's fields.
type submission struct {
	cols  []map[string]any
	lines [][]string
}

// parseSubmission validates every field value against its type and the
// column it maps, and coerces fixed values. Request keys that aren't a field
// id are ignored; column names come only from the (validated) config.
func parseSubmission(cfg formtarget.FormConfig, values map[string]json.RawMessage, colType func(table, col string) (string, bool)) (submission, error) {
	sub := submission{cols: make([]map[string]any, len(cfg.Targets)), lines: make([][]string, len(cfg.Targets))}
	for i, t := range cfg.Targets {
		sub.cols[i] = map[string]any{}
		for col, raw := range t.Fixed {
			gt, _ := colType(t.Table, col)
			v, err := coerce(gt, raw)
			if err != nil {
				return submission{}, errFormUnusable
			}
			sub.cols[i][col] = v
		}
	}
	var bad []string
	for _, f := range cfg.Fields {
		table := cfg.Targets[f.Target].Table
		got, display, err := parseFieldValue(f, values[f.ID], func(col string) string {
			gt, _ := colType(table, col)
			return gt
		})
		if err != nil {
			bad = append(bad, f.ID)
			continue
		}
		for col, v := range got {
			sub.cols[f.Target][col] = v
		}
		if display != "" {
			sub.lines[f.Target] = append(sub.lines[f.Target], f.Label+": "+display)
		}
	}
	if len(bad) > 0 {
		return submission{}, &formFieldError{ids: bad}
	}
	return sub, nil
}

var errValue = errors.New("invalid value")

// parseFieldValue validates one submitted value. It returns the column values
// to write (nil when the value is empty and optional) and its display text.
// colType gives the Go type of a column of the field's target ("" unknown).
func parseFieldValue(f formtarget.FormField, raw json.RawMessage, colType func(col string) string) (map[string]any, string, error) {
	if isEmptyJSON(raw) {
		if f.Required {
			return nil, "", errValue
		}
		return nil, "", nil
	}
	if f.Type == "address" {
		return parseAddress(f, raw, colType)
	}
	var display string
	var value any
	switch f.Type {
	case "text", "long", "phone", "email", "select":
		s, err := jsonString(raw)
		if err != nil {
			return nil, "", err
		}
		if s == "" {
			if f.Required {
				return nil, "", errValue
			}
			return nil, "", nil
		}
		limit := maxTextLen
		switch f.Type {
		case "long":
			limit = maxLongLen
		case "phone":
			limit = maxPhoneLen
		case "email":
			limit = maxEmailLen
		}
		if utf8.RuneCountInString(s) > limit {
			return nil, "", errValue
		}
		switch f.Type {
		case "email":
			a, err := mail.ParseAddress(s)
			if err != nil || a.Address != s {
				return nil, "", errValue
			}
		case "select":
			found := false
			for _, o := range f.Options {
				found = found || o == s
			}
			if !found {
				return nil, "", errValue
			}
		}
		display, value = s, s
	case "number":
		n, err := jsonNumber(raw)
		if err != nil {
			return nil, "", err
		}
		display, value = strconv.FormatFloat(n, 'f', -1, 64), n
	case "date":
		s, err := jsonString(raw)
		if err != nil {
			return nil, "", err
		}
		if s == "" {
			if f.Required {
				return nil, "", errValue
			}
			return nil, "", nil
		}
		d, err := time.Parse(time.DateOnly, s)
		if err != nil {
			return nil, "", errValue
		}
		display, value = s, d
	case "checkbox":
		var b bool
		if err := json.Unmarshal(raw, &b); err != nil {
			return nil, "", errValue
		}
		if f.Required && !b {
			return nil, "", errValue // a required checkbox is a consent: it must be ticked
		}
		display, value = "no", false
		if b {
			display, value = "yes", true
		}
	default:
		return nil, "", errValue
	}
	v, err := toColumn(colType(f.Column), value)
	if err != nil {
		return nil, "", err
	}
	return map[string]any{f.Column: v}, display, nil
}

// parseAddress validates an address value {number, complement, street,
// zip_code, city, state, country}; required = street and city filled.
func parseAddress(f formtarget.FormField, raw json.RawMessage, colType func(col string) string) (map[string]any, string, error) {
	var in map[string]json.RawMessage
	if err := json.Unmarshal(raw, &in); err != nil || in == nil {
		return nil, "", errValue
	}
	out := map[string]any{}
	var parts []string
	for _, suffix := range formtarget.AddressSuffixes() {
		key := strings.TrimPrefix(suffix, "_")
		sub := in[key]
		if isEmptyJSON(sub) {
			continue
		}
		var v any
		var text string
		if key == "number" {
			n, err := jsonNumber(sub)
			if err != nil || n != math.Trunc(n) || n < 0 || n > math.MaxInt32 {
				return nil, "", errValue
			}
			v, text = n, strconv.FormatFloat(n, 'f', -1, 64)
		} else {
			s, err := jsonString(sub)
			if err != nil || utf8.RuneCountInString(s) > maxAddrLen {
				return nil, "", errValue
			}
			if s == "" {
				continue
			}
			v, text = s, s
		}
		cv, err := toColumn(colType(f.Column+suffix), v)
		if err != nil {
			return nil, "", err
		}
		out[f.Column+suffix] = cv
		parts = append(parts, text)
	}
	if f.Required && (out[f.Column+"_street"] == nil || out[f.Column+"_city"] == nil) {
		return nil, "", errValue
	}
	if len(out) == 0 {
		return nil, "", nil
	}
	return out, strings.Join(parts, " "), nil
}

func isEmptyJSON(raw json.RawMessage) bool {
	s := strings.TrimSpace(string(raw))
	return s == "" || s == "null" || s == `""`
}

// jsonString reads a JSON string, trimmed.
func jsonString(raw json.RawMessage) (string, error) {
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return "", errValue
	}
	return strings.TrimSpace(s), nil
}

// jsonNumber reads a finite JSON number (or a numeric string).
func jsonNumber(raw json.RawMessage) (float64, error) {
	var n float64
	if err := json.Unmarshal(raw, &n); err != nil {
		s, serr := jsonString(raw)
		if serr != nil {
			return 0, errValue
		}
		if n, err = strconv.ParseFloat(s, 64); err != nil {
			return 0, errValue
		}
	}
	if math.IsNaN(n) || math.IsInf(n, 0) {
		return 0, errValue
	}
	return n, nil
}

// toColumn converts a validated value (string, float64, bool or time.Time)
// to what a column of Go type goType holds; an impossible conversion (text
// into an integer column, a fraction into an int…) is errValue.
func toColumn(goType string, v any) (any, error) {
	switch strings.TrimPrefix(goType, "*") {
	case "", "string":
		switch x := v.(type) {
		case string:
			return x, nil
		case float64:
			return strconv.FormatFloat(x, 'f', -1, 64), nil
		case bool:
			return strconv.FormatBool(x), nil
		case time.Time:
			return x.Format(time.DateOnly), nil
		}
	case "int", "int32", "int64":
		var n float64
		switch x := v.(type) {
		case float64:
			n = x
		case string:
			p, err := strconv.ParseFloat(x, 64)
			if err != nil {
				return nil, errValue
			}
			n = p
		default:
			return nil, errValue
		}
		limit := float64(math.MaxInt32)
		if strings.TrimPrefix(goType, "*") == "int64" {
			limit = 1 << 53
		}
		if n != math.Trunc(n) || math.Abs(n) > limit {
			return nil, errValue
		}
		return int64(n), nil
	case "float64", "float32":
		switch x := v.(type) {
		case float64:
			return x, nil
		case string:
			if n, err := strconv.ParseFloat(x, 64); err == nil && !math.IsInf(n, 0) && !math.IsNaN(n) {
				return n, nil
			}
		}
	case "bool":
		switch x := v.(type) {
		case bool:
			return x, nil
		case string:
			if b, err := strconv.ParseBool(x); err == nil {
				return b, nil
			}
		}
	case "time.Time":
		switch x := v.(type) {
		case time.Time:
			return x, nil
		case string:
			if d, err := time.Parse(time.DateOnly, x); err == nil {
				return d, nil
			}
		}
	case "uuid.UUID":
		if x, ok := v.(string); ok {
			if id, err := uuid.Parse(x); err == nil {
				return id, nil
			}
		}
	}
	return nil, errValue
}

// coerce converts a fixed (designer-set, string) value to its column type.
func coerce(goType, raw string) (any, error) { return toColumn(goType, raw) }

// write runs every target in order inside tx; ids[i] is target i's record.
func (h *FormHandler) write(ctx context.Context, tx *orm.Tx, title string, cfg formtarget.FormConfig, sub submission, visitor *auth.Users) error {
	ids := make([]uuid.UUID, len(cfg.Targets))
	for i, t := range cfg.Targets {
		cols := sub.cols[i]
		for col, from := range t.Links {
			cols[col] = ids[from]
		}
		if t.Table == "contact" {
			id, err := h.writeContact(ctx, tx, title, cols, sub.lines[i], visitor)
			if err != nil {
				return err
			}
			ids[i] = id
			continue
		}
		id, err := insertRow(ctx, tx, t.Table, h.tenant, cols)
		if err != nil {
			return err
		}
		ids[i] = id
	}
	return nil
}

// writeContact resolves a contact target. A signed-in visitor's own website
// contact is updated (created if their account predates the link); the
// account email is kept so the contact stays theirs. An anonymous visitor
// goes through contact.FindOrCreateContact by email: a contact that already
// existed is never written (the values go to its chatter instead).
func (h *FormHandler) writeContact(ctx context.Context, tx *orm.Tx, title string, cols map[string]any, lines []string, visitor *auth.Users) (uuid.UUID, error) {
	if visitor != nil {
		id, err := contact.WebsiteContactID(ctx, tx, h.tenant, visitor.Email)
		if err != nil {
			return uuid.Nil, err
		}
		if id == uuid.Nil {
			p := contact.WebsiteContact{Name: visitor.Name, Surname: visitor.Surname, Email: visitor.Email, Phone: visitor.Phone}
			if id, err = contact.CreateWebsiteContact(ctx, tx, h.tenant, p); err != nil {
				return uuid.Nil, err
			}
		}
		delete(cols, "email")
		return id, updateRow(ctx, tx, "contact", h.tenant, id, cols)
	}

	email, _ := cols["email"].(string)
	if email == "" {
		// No email to match on: a new contact, like any other target.
		if _, ok := cols["kind"]; !ok {
			cols["kind"] = contact.KindContact
		}
		return insertRow(ctx, tx, "contact", h.tenant, cols)
	}
	name, _ := cols["name"].(string)
	if name == "" {
		name = email
	}
	id, created, err := contact.FindOrCreateContact(ctx, tx, h.tenant, name, email)
	if err != nil {
		return uuid.Nil, err
	}
	if created {
		delete(cols, "email") // already stored, lowercased
		return id, updateRow(ctx, tx, "contact", h.tenant, id, cols)
	}
	body := `Website form "` + title + `"`
	if len(lines) > 0 {
		body += ": " + strings.Join(lines, "; ")
	}
	_, err = orm.MustRepo[chatter.ChatterMessage](tx).Create(ctx, chatter.ChatterMessage{
		TenantID: h.tenant, TableName: "contact", RecordID: id, AuthorEmail: email, Kind: "log", Body: body})
	return id, err
}

// quoteIdent quotes a SQL identifier. Names only ever come from the
// registered, validated form target set — never from the request.
func quoteIdent(s string) string { return `"` + strings.ReplaceAll(s, `"`, `""`) + `"` }

func insertRow(ctx context.Context, tx *orm.Tx, table string, tenant uuid.UUID, cols map[string]any) (uuid.UUID, error) {
	names := []string{"tenant_id"}
	args := []any{tenant}
	marks := []string{"$1"}
	for col, v := range cols {
		args = append(args, v)
		names = append(names, quoteIdent(col))
		marks = append(marks, "$"+strconv.Itoa(len(args)))
	}
	var id uuid.UUID
	err := tx.QueryRow(ctx, `INSERT INTO `+quoteIdent(table)+` (`+strings.Join(names, ", ")+`) VALUES (`+
		strings.Join(marks, ", ")+`) RETURNING id`, args...).Scan(&id)
	return id, err
}

func updateRow(ctx context.Context, tx *orm.Tx, table string, tenant, id uuid.UUID, cols map[string]any) error {
	if len(cols) == 0 {
		return nil
	}
	args := []any{id, tenant}
	sets := []string{"updated_at = now()"}
	for col, v := range cols {
		args = append(args, v)
		sets = append(sets, quoteIdent(col)+" = $"+strconv.Itoa(len(args)))
	}
	_, err := tx.Exec(ctx, `UPDATE `+quoteIdent(table)+` SET `+strings.Join(sets, ", ")+
		` WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, args...)
	return err
}

// MyContact handles GET /api/v1/website/me/contact (WebsiteJWTMiddleware):
// the visitor's own website contact, for pre-filling forms; 404 when none.
func (h *FormHandler) MyContact(c *echo.Context) error {
	ctx := c.Request().Context()
	id := auth.MustIdentity(ctx)
	u, err := h.users.FindByID(ctx, id.UserID)
	if errors.Is(err, orm.ErrNotFound) || (err == nil && u.TenantID != id.TenantID) {
		return echo.NewHTTPError(http.StatusNotFound, "not found")
	}
	if err != nil {
		return err
	}
	cid, err := contact.WebsiteContactID(ctx, h.db, id.TenantID, u.Email)
	if err != nil {
		return err
	}
	if cid == uuid.Nil {
		return echo.NewHTTPError(http.StatusNotFound, "not found")
	}
	var name, email string
	var surname, phone, complement, street, zip, city, state, country *string
	var number *int
	err = h.db.QueryRow(ctx, `SELECT name, surname, email, phone, address_number, address_complement,
		address_street, address_zip_code, address_city, address_state, address_country
		FROM contact WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, cid, id.TenantID).Scan(
		&name, &surname, &email, &phone, &number, &complement, &street, &zip, &city, &state, &country)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, map[string]any{
		"name": name, "surname": surname, "email": email, "phone": phone,
		"address_number": number, "address_complement": complement, "address_street": street,
		"address_zip_code": zip, "address_city": city, "address_state": state, "address_country": country,
	})
}

// FormTargets handles GET /api/v1/settings/website/form_targets (staff,
// settings:website:read): the registered targets of active modules, sorted.
func (h *FormHandler) FormTargets(c *echo.Context) error {
	out := []formtarget.Target{}
	for _, t := range formtarget.Targets() {
		if h.isActive(t.Table) {
			out = append(out, t)
		}
	}
	return c.JSON(http.StatusOK, map[string]any{"data": out})
}
