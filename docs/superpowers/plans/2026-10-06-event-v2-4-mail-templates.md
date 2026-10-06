# Event v2 · SP4 — Email templates, languages, reminders — Implementation Plan

**Spec:** [Event v2 overview § SP4](../specs/2026-10-06-event-v2-overview.md#sp4-email-templates-languages-reminders)

**Goal:** every transactional email is an admin-editable, translated template; event bookings
get a reminder before the start.

**Global constraints:** templates are `{{var}}` substitution only — no logic — over a variable
list each key declares in code; unknown variables are refused on save; HTML is sanitized
(allowlist) on save; values are HTML-escaped in the HTML part; the text part is derived from the
HTML so the two never drift. `internal/mail` must not import `internal/settings` (settings →
auth → mail would cycle), so the workspace default language key is read as a literal.

## File structure

- `core/internal/mail/template.go` — `TemplateDef`/`Content`, `RegisterTemplate`, `Render`,
  `ValidateTemplate`, `{{var}}` substitution
- `core/internal/mail/htmlsafe.go` — `SanitizeHTML` (allowlist), `HTMLToText`
- `core/internal/mail/locale.go` — `ResolveLocale` (user → workspace → en), `FormatDateTime`
- `core/internal/mail/template_handler.go` — `GET /api/v1/settings/mail_templates`,
  `PUT|DELETE /api/v1/settings/mail_templates/:key/:locale` (`settings:mail_templates:*`)
- `core/modules/mail/module.go` — `mail_template` table (off the generic surface) + unique index
- `core/modules/event/emails.go` — templates registered, rendered per locale; reminder email
- `core/modules/event/reminders.go` — `SendReminders` sweep; `events.settings`
  (`GET|PUT /api/v1/settings/events`, `settings:events:*`)
- `core/internal/auth/admin_repository.go` — verification email through `website.verify_email`
- `core/internal/app/app.go` — routes, 5-minute reminder ticker in `Run`
- `core-front/packages/core-front` — `text/html` widget (`HtmlEditor`, Tiptap)
- `core-front/apps/shell` — Settings → Email templates page, Event settings section, Event →
  Configuration → Email templates link

### Task 1: Template engine (Go)

- [x] Failing tests: sanitizer drops scripts/handlers/js: URLs and keeps allowed markup and
  `{{var}}` hrefs; HTML→text; unknown variable refused; values escaped in HTML, raw in subject;
  lookup chain stored(locale) → default(locale) → base language → en; locale resolution.
- [x] Implement; run.

### Task 2: Admin API + table

- [x] Failing app test: catalog lists registered keys with variables and defaults; PUT stores a
  sanitized override (400 on unknown variable / unknown key / bad locale); a later render uses
  it; DELETE reverts.
- [x] Implement; run.

### Task 3: Event + website emails on templates, reminders

- [x] Failing tests: confirmation in the account's language; reminder sweep sends once, only
  for confirmed bookings booked before the window, never when `reminder_hours` = 0.
- [x] Implement; wire the ticker; run backend suites.

### Task 4: Frontend

- [x] `text/html` widget + tests; Email templates page + tests; Event settings section; menu
  link; i18n.

### Task 5: Docs

- [x] ADR-027 (core mail templates), CLAUDE.md (mail, event), core-front CLAUDE.md.
