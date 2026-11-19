package mail

import (
	"context"
	"errors"
	"fmt"
	"html"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"

	"core/orm"
	"core/orm/model"

	"github.com/google/uuid"
)

// Email templates (ADR-027): a module declares each email it sends — a key,
// the variables it fills, and default texts per language — with
// RegisterTemplate at init. Admins may override any (key, language) in their
// tenant (mail_template, Settings → Email templates). Render picks the text,
// substitutes {{var}} and derives the plain-text part from the HTML.

var (
	ErrUnknownTemplate = errors.New("mail: unknown template")
	ErrInvalidTemplate = errors.New("mail: invalid template")
)

// Content is one language's text of a template: a one-line subject and an
// HTML body, both with {{var}} placeholders.
type Content struct {
	Subject string `json:"subject"`
	HTML    string `json:"html"`
}

// TemplateDef declares a template. Defaults must hold "en", the last fallback.
type TemplateDef struct {
	Key      string             `json:"key"`
	Label    string             `json:"label"`
	Vars     []string           `json:"vars"`
	Defaults map[string]Content `json:"defaults"`
}

// Template is a tenant's override of one (key, locale). Off the generic CRUD
// surface: writes must be validated and sanitized (template_handler.go).
type Template struct {
	model.BaseModel
	Key     string `db:"key"`
	Locale  string `db:"locale"`
	Subject string `db:"subject"`
	HTML    string `db:"body_html"`
}

// TemplateUniqueIndex backs SaveTemplate's upsert (modules/mail's Migrate).
const TemplateUniqueIndex = `CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_template_key
	ON mail_template (tenant_id, key, locale) WHERE deleted_at IS NULL`

var (
	registryMu sync.RWMutex
	registry   = map[string]TemplateDef{}
)

// RegisterTemplate declares a template; a module calls it from init(). A
// second registration of a key replaces the first.
func RegisterTemplate(def TemplateDef) {
	if _, ok := def.Defaults["en"]; !ok {
		panic("mail: template " + def.Key + " has no English default")
	}
	registryMu.Lock()
	defer registryMu.Unlock()
	registry[def.Key] = def
}

// Templates lists the registered templates, sorted by key.
func Templates() []TemplateDef {
	registryMu.RLock()
	defer registryMu.RUnlock()
	out := make([]TemplateDef, 0, len(registry))
	for _, d := range registry {
		out = append(out, d)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Key < out[j].Key })
	return out
}

func lookupDef(key string) (TemplateDef, bool) {
	registryMu.RLock()
	defer registryMu.RUnlock()
	d, ok := registry[key]
	return d, ok
}

var (
	placeholder = regexp.MustCompile(`\{\{\s*([a-z_]+)\s*\}\}`)
	localeTag   = regexp.MustCompile(`^[a-z]{2,3}(-[A-Z]{2})?$`)
)

// ValidateTemplate checks a subject/body pair against def: a non-empty
// one-line subject, and only declared variables.
func ValidateTemplate(def TemplateDef, subject, body string) error {
	if strings.TrimSpace(subject) == "" || strings.ContainsAny(subject, "\r\n") || len(subject) > 300 {
		return fmt.Errorf("%w: the subject is required, one line, at most 300 characters", ErrInvalidTemplate)
	}
	if len(body) > 100_000 {
		return fmt.Errorf("%w: the body is too long", ErrInvalidTemplate)
	}
	for _, m := range placeholder.FindAllStringSubmatch(subject+body, -1) {
		if !slices.Contains(def.Vars, m[1]) {
			return fmt.Errorf("%w: unknown variable {{%s}} (available: %s)", ErrInvalidTemplate, m[1], strings.Join(def.Vars, ", "))
		}
	}
	return nil
}

// SaveTemplate stores tenant's override of (key, locale), sanitized.
func SaveTemplate(ctx context.Context, ex orm.Executor, tenant uuid.UUID, key, locale, subject, body string) error {
	def, ok := lookupDef(key)
	if !ok {
		return ErrUnknownTemplate
	}
	if !localeTag.MatchString(locale) {
		return fmt.Errorf("%w: locale must look like \"fr\" or \"pt-BR\"", ErrInvalidTemplate)
	}
	body = SanitizeHTML(body)
	if err := ValidateTemplate(def, subject, body); err != nil {
		return err
	}
	_, err := ex.Exec(ctx, `
		INSERT INTO mail_template (tenant_id, key, locale, subject, body_html) VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (tenant_id, key, locale) WHERE deleted_at IS NULL
		DO UPDATE SET subject = EXCLUDED.subject, body_html = EXCLUDED.body_html, updated_at = now()`,
		tenant, key, locale, strings.TrimSpace(subject), body)
	return err
}

// DeleteTemplate drops tenant's override of (key, locale): the default applies again.
func DeleteTemplate(ctx context.Context, ex orm.Executor, tenant uuid.UUID, key, locale string) error {
	_, err := ex.Exec(ctx, `DELETE FROM mail_template WHERE tenant_id = $1 AND key = $2 AND locale = $3`, tenant, key, locale)
	return err
}

// Overrides returns tenant's stored overrides, keyed by template key then locale.
func Overrides(ctx context.Context, ex orm.Executor, tenant uuid.UUID) (map[string]map[string]Content, error) {
	rows, err := ex.Query(ctx, `SELECT key, locale, subject, body_html FROM mail_template
		WHERE tenant_id = $1 AND deleted_at IS NULL`, tenant)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]map[string]Content{}
	for rows.Next() {
		var key, locale string
		var c Content
		if err := rows.Scan(&key, &locale, &c.Subject, &c.HTML); err != nil {
			return nil, err
		}
		if out[key] == nil {
			out[key] = map[string]Content{}
		}
		out[key][locale] = c
	}
	return out, rows.Err()
}

// localeChain: "pt-BR" → pt-BR, pt, en.
func localeChain(locale string) []string {
	chain := []string{}
	if locale != "" {
		chain = append(chain, locale)
		if base, _, ok := strings.Cut(locale, "-"); ok {
			chain = append(chain, base)
		}
	}
	return append(chain, "en")
}

// Render builds key's email for tenant in locale: for each language of the
// chain (locale, its base language, English) the tenant's override wins over
// the default. vars fill {{placeholders}} — as-is in the subject, escaped in
// the HTML; the text part is derived from the HTML. The result has no
// recipient or tenant yet.
func Render(ctx context.Context, ex orm.Executor, tenant uuid.UUID, key, locale string, vars map[string]string) (Message, error) {
	def, ok := lookupDef(key)
	if !ok {
		return Message{}, fmt.Errorf("%w: %s", ErrUnknownTemplate, key)
	}
	var c Content
	found := false
	for _, l := range localeChain(locale) {
		err := ex.QueryRow(ctx, `SELECT subject, body_html FROM mail_template
			WHERE tenant_id = $1 AND key = $2 AND locale = $3 AND deleted_at IS NULL`, tenant, key, l).Scan(&c.Subject, &c.HTML)
		if err == nil {
			found = true
			break
		}
		if !errors.Is(err, orm.ErrNotFound) {
			return Message{}, err
		}
		if c, found = def.Defaults[l]; found {
			break
		}
	}
	if !found { // unreachable: RegisterTemplate requires an English default
		return Message{}, fmt.Errorf("%w: %s has no text", ErrUnknownTemplate, key)
	}
	fill := func(s string, escape bool) string {
		return placeholder.ReplaceAllStringFunc(s, func(m string) string {
			v := vars[placeholder.FindStringSubmatch(m)[1]]
			if escape {
				return html.EscapeString(v)
			}
			return v
		})
	}
	body := fill(c.HTML, true)
	return Message{Subject: oneLine.Replace(fill(c.Subject, false)), HTML: body, Text: HTMLToText(body)}, nil
}

// oneLine keeps values from breaking the Subject header.
var oneLine = strings.NewReplacer("\r\n", " ", "\r", " ", "\n", " ")
