package mail

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"core/internal/testdb"
	"core/orm"

	"github.com/google/uuid"
)

func TestSanitizeHTML(t *testing.T) {
	tests := []struct {
		name, in, want string
	}{
		{"keeps allowed markup", `<p>Hi <strong>there</strong>, <em>you</em></p><ul><li>one</li></ul>`,
			`<p>Hi <strong>there</strong>, <em>you</em></p><ul><li>one</li></ul>`},
		{"drops script with its content", `<p>a</p><script>alert(1)</script>`, `<p>a</p>`},
		{"drops event handlers and unknown attributes", `<p onclick="x()" class="c">a</p>`, `<p>a</p>`},
		{"unwraps unknown tags, keeps text", `<div><font>a</font></div>`, `a`},
		{"refuses javascript: links", `<a href="javascript:alert(1)">x</a>`, `<a>x</a>`},
		{"keeps http, mailto and placeholder links", `<a href="https://x.io">x</a><a href="mailto:a@b.c">m</a><a href="{{cancel_url}}">c</a>`,
			`<a href="https://x.io">x</a><a href="mailto:a@b.c">m</a><a href="{{cancel_url}}">c</a>`},
		{"keeps placeholders in text", `<p>Hello {{name}}</p>`, `<p>Hello {{name}}</p>`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := SanitizeHTML(tt.in); got != tt.want {
				t.Errorf("SanitizeHTML(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestHTMLToText(t *testing.T) {
	got := HTMLToText(`<p>Hello <strong>Ann</strong> &amp; co,</p><ul><li>one</li><li>two</li></ul><p><a href="https://x.io/c">Cancel</a><br>Bye</p>`)
	want := "Hello Ann & co,\n\n- one\n- two\n\nCancel (https://x.io/c)\nBye"
	if got != want {
		t.Errorf("HTMLToText =\n%q\nwant\n%q", got, want)
	}
}

func testDef() TemplateDef {
	return TemplateDef{
		Key: "test.greeting", Label: "Greeting", Vars: []string{"name", "url"},
		Defaults: map[string]Content{
			"en": {Subject: "Hello {{name}}", HTML: `<p>Hi {{name}}</p><p><a href="{{url}}">open</a></p>`},
			"fr": {Subject: "Bonjour {{name}}", HTML: `<p>Salut {{name}}</p>`},
		},
	}
}

func TestValidateTemplate(t *testing.T) {
	def := testDef()
	if err := ValidateTemplate(def, "Hi {{name}}", "<p>{{ url }}</p>"); err != nil {
		t.Errorf("declared variables refused: %v", err)
	}
	for _, c := range []struct{ subject, html string }{
		{"Hi {{surname}}", "<p></p>"},
		{"Hi", `<a href="{{secret}}">x</a>`},
		{"", "<p>x</p>"},
		{"a\nb", "<p>x</p>"},
	} {
		if err := ValidateTemplate(def, c.subject, c.html); !errors.Is(err, ErrInvalidTemplate) {
			t.Errorf("ValidateTemplate(%q, %q) = %v, want ErrInvalidTemplate", c.subject, c.html, err)
		}
	}
}

func setupTemplates(t *testing.T) (*orm.App, uuid.UUID) {
	t.Helper()
	app := testdb.Open(t)
	if err := orm.Register[Template](orm.WithTableName("mail_template"), orm.WithExcluded()); err != nil {
		t.Fatal(err)
	}
	testdb.Migrate(t, app, "mail_template")
	if _, err := app.DB.Exec(context.Background(), TemplateUniqueIndex); err != nil {
		t.Fatal(err)
	}
	tenant := uuid.New()
	t.Cleanup(func() {
		_, _ = app.DB.Exec(context.Background(), `DELETE FROM mail_template WHERE tenant_id = $1`, tenant)
	})
	return app, tenant
}

func TestRender_LookupChainAndEscaping(t *testing.T) {
	ctx := context.Background()
	app, tenant := setupTemplates(t)
	RegisterTemplate(testDef())
	vars := map[string]string{"name": "<Ann>", "url": "https://x.io/?a=1&b=2"}

	en, err := Render(ctx, app.DB, tenant, "test.greeting", "en", vars)
	if err != nil {
		t.Fatal(err)
	}
	if en.Subject != "Hello <Ann>" || !strings.Contains(en.HTML, "Hi &lt;Ann&gt;") || !strings.Contains(en.HTML, `href="https://x.io/?a=1&amp;b=2"`) {
		t.Errorf("en render = %+v", en)
	}
	if !strings.Contains(en.Text, "Hi <Ann>") || !strings.Contains(en.Text, "open (https://x.io/?a=1&b=2)") {
		t.Errorf("en text = %q", en.Text)
	}
	if fr, _ := Render(ctx, app.DB, tenant, "test.greeting", "fr-CA", vars); fr.Subject != "Bonjour <Ann>" {
		t.Errorf("fr-CA falls back to fr: subject %q", fr.Subject)
	}
	if de, _ := Render(ctx, app.DB, tenant, "test.greeting", "de", vars); de.Subject != "Hello <Ann>" {
		t.Errorf("de falls back to en: subject %q", de.Subject)
	}

	if err := SaveTemplate(ctx, app.DB, tenant, "test.greeting", "fr", "Coucou {{name}}", `<p>Coucou</p><script>x</script>`); err != nil {
		t.Fatal(err)
	}
	fr, _ := Render(ctx, app.DB, tenant, "test.greeting", "fr", vars)
	if fr.Subject != "Coucou <Ann>" || strings.Contains(fr.HTML, "script") {
		t.Errorf("stored override = %+v, want sanitized custom fr", fr)
	}
	if other, _ := Render(ctx, app.DB, uuid.New(), "test.greeting", "fr", vars); other.Subject != "Bonjour <Ann>" {
		t.Errorf("another tenant sees the override: %q", other.Subject)
	}
	if err := DeleteTemplate(ctx, app.DB, tenant, "test.greeting", "fr"); err != nil {
		t.Fatal(err)
	}
	if fr, _ := Render(ctx, app.DB, tenant, "test.greeting", "fr", vars); fr.Subject != "Bonjour <Ann>" {
		t.Errorf("after delete subject %q, want the default back", fr.Subject)
	}
	if _, err := Render(ctx, app.DB, tenant, "nope", "en", vars); !errors.Is(err, ErrUnknownTemplate) {
		t.Errorf("unknown key: %v", err)
	}
	if err := SaveTemplate(ctx, app.DB, tenant, "test.greeting", "en", "Hi {{nope}}", "<p></p>"); !errors.Is(err, ErrInvalidTemplate) {
		t.Errorf("save with an unknown variable: %v", err)
	}
	if err := SaveTemplate(ctx, app.DB, tenant, "test.greeting", "../x", "Hi", "<p></p>"); !errors.Is(err, ErrInvalidTemplate) {
		t.Errorf("save with a bad locale: %v", err)
	}
}

func TestFormatDateTime(t *testing.T) {
	paris, _ := time.LoadLocation("Europe/Paris")
	at := time.Date(2026, 10, 5, 9, 30, 0, 0, paris)
	if got := FormatDateTime(at, "fr"); got != "lundi 5 octobre 2026, 09:30 (CEST)" {
		t.Errorf("fr = %q", got)
	}
	if got := FormatDateTime(at, "en"); got != "Monday 5 October 2026, 09:30 (CEST)" {
		t.Errorf("en = %q", got)
	}
	if got := FormatDateTime(at, "de"); got != FormatDateTime(at, "en") {
		t.Errorf("unknown language falls back to en: %q", got)
	}
}
