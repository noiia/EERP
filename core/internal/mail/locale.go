package mail

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"core/orm"

	"github.com/google/uuid"
)

// defaultLocaleKey mirrors settings.DefaultLocaleKey; internal/settings
// imports auth, which imports this package, so it can't be imported here.
const defaultLocaleKey = "i18n.default_locale"

// ResolveLocale is the language of an email to userID (nil: no account): the
// account's preferred_locale, else the workspace default, else English. The
// reserved "source" preference is the untranslated source language, English.
// The workspace default is stored per company; an email isn't sent "as" a
// company, so the first company's setting stands for the workspace.
func ResolveLocale(ctx context.Context, ex orm.Executor, tenant uuid.UUID, userID *uuid.UUID) (string, error) {
	if userID != nil {
		var pref *string
		err := ex.QueryRow(ctx, `SELECT preferred_locale FROM users WHERE id = $1 AND tenant_id = $2`, *userID, tenant).Scan(&pref)
		if err != nil && !errors.Is(err, orm.ErrNotFound) {
			return "", err
		}
		if pref != nil && *pref != "" {
			if *pref == "source" {
				return "en", nil
			}
			return *pref, nil
		}
	}
	var def string
	err := ex.QueryRow(ctx, `SELECT value FROM app_settings
		WHERE tenant_id = $1 AND key = $2 AND value <> '' AND deleted_at IS NULL
		ORDER BY created_at LIMIT 1`, tenant, defaultLocaleKey).Scan(&def)
	if errors.Is(err, orm.ErrNotFound) {
		return "en", nil
	}
	if err != nil {
		return "", err
	}
	return def, nil
}

// Weekday and month names of the languages emails format dates in; any other
// language falls back to English. Go has no locale-aware date formatting.
var dateNames = map[string]struct {
	days   [7]string
	months [12]string
	layout string // %s day, %d date, %s month, %d year, then time
}{
	"en": {
		[7]string{"Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"},
		[12]string{"January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"},
		"%s %d %s %d, %s (%s)",
	},
	"fr": {
		[7]string{"dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"},
		[12]string{"janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"},
		"%s %d %s %d, %s (%s)",
	},
}

// FormatDateTime writes t (already in the event's zone) for an email in
// locale: "Monday 5 October 2026, 09:30 (CEST)".
func FormatDateTime(t time.Time, locale string) string {
	base, _, _ := strings.Cut(locale, "-")
	n, ok := dateNames[base]
	if !ok {
		n = dateNames["en"]
	}
	zone, _ := t.Zone()
	return fmt.Sprintf(n.layout, n.days[t.Weekday()], t.Day(), n.months[t.Month()-1], t.Year(), t.Format("15:04"), zone)
}
