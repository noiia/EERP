package event

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"core/internal/auth"
	eerpmail "core/internal/mail"
	"core/internal/settings"
	"core/orm"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

// SettingsKey holds the tenant's event settings as JSON, in app_settings'
// tenant-wide slot (company_id = uuid.Nil): reminders aren't per company.
const SettingsKey = "events.settings"

// Defaults while a tenant has saved no setting.
const (
	DefaultReminderHours      = 24
	DefaultWaitlistClaimHours = 12
)

// Settings are the Event app's workspace settings.
type Settings struct {
	// ReminderHours: how long before the start a confirmed booking gets its
	// reminder email; 0 = no reminders.
	ReminderHours int `json:"reminder_hours"`
	// WaitlistClaimHours: how long a waiting-list offer stays claimable.
	WaitlistClaimHours int `json:"waitlist_claim_hours"`
}

func loadSettings(ctx context.Context, store *settings.Repository, tenant uuid.UUID) (Settings, error) {
	s := Settings{ReminderHours: DefaultReminderHours, WaitlistClaimHours: DefaultWaitlistClaimHours}
	raw, ok, err := store.Get(ctx, tenant, uuid.Nil, SettingsKey)
	if err != nil || !ok || raw == "" {
		return s, err
	}
	if err := json.Unmarshal([]byte(raw), &s); err != nil {
		return s, err
	}
	if s.WaitlistClaimHours <= 0 { // saved before the setting existed
		s.WaitlistClaimHours = DefaultWaitlistClaimHours
	}
	return s, nil
}

// GetSettings handles GET /api/v1/settings/events (settings:events:read).
func (h *Handler) GetSettings(c *echo.Context) error {
	ctx := c.Request().Context()
	id, ok := auth.IdentityFromContext(ctx)
	if !ok {
		return echo.NewHTTPError(http.StatusUnauthorized, "authentication required")
	}
	s, err := loadSettings(ctx, settings.NewRepository(h.db), id.TenantID)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, s)
}

// PutSettings handles PUT /api/v1/settings/events (settings:events:write).
func (h *Handler) PutSettings(c *echo.Context) error {
	ctx := c.Request().Context()
	id, ok := auth.IdentityFromContext(ctx)
	if !ok {
		return echo.NewHTTPError(http.StatusUnauthorized, "authentication required")
	}
	var in Settings
	if err := json.NewDecoder(c.Request().Body).Decode(&in); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "malformed body")
	}
	if in.ReminderHours < 0 || in.ReminderHours > 720 {
		return echo.NewHTTPError(http.StatusBadRequest, "reminder_hours must be 0 to 720")
	}
	if in.WaitlistClaimHours == 0 {
		in.WaitlistClaimHours = DefaultWaitlistClaimHours
	}
	if in.WaitlistClaimHours < 1 || in.WaitlistClaimHours > 168 {
		return echo.NewHTTPError(http.StatusBadRequest, "waitlist_claim_hours must be 1 to 168")
	}
	raw, _ := json.Marshal(in)
	if err := settings.NewRepository(h.db).Set(ctx, id.TenantID, uuid.Nil, SettingsKey, string(raw)); err != nil {
		return err
	}
	return c.JSON(http.StatusOK, in)
}

// SendReminders queues the reminder of every confirmed booking whose start
// falls within its tenant's reminder window, once (reminder_sent_at) — a
// booking made inside the window already got its confirmation, so it gets
// none. Rows are claimed FOR UPDATE SKIP LOCKED in batches, each batch in one
// transaction with its emails, so several processes can sweep at once.
// Returns how many reminders were queued.
func (s *Service) SendReminders(ctx context.Context) (int, error) {
	total := 0
	for {
		n, err := s.sendReminderBatch(ctx)
		total += n
		if err != nil || n == 0 {
			return total, err
		}
	}
}

const reminderBatch = 50

func (s *Service) sendReminderBatch(ctx context.Context) (int, error) {
	sent := 0
	err := orm.Transact(ctx, s.db, func(tx *orm.Tx) error {
		rows, err := tx.Query(ctx, `
			WITH cfg AS (
				SELECT tenant_id, (value::jsonb ->> 'reminder_hours')::int AS hours FROM app_settings
				WHERE key = $1 AND company_id = $2 AND deleted_at IS NULL AND value <> '')
			SELECT b.id, b.tenant_id, b.event_id, b.seats, b.email, b.name, b.user_id, b.cancel_token, b.starts_at
			FROM event_booking b
			LEFT JOIN cfg ON cfg.tenant_id = b.tenant_id
			WHERE b.status = $3 AND b.reminder_sent_at IS NULL AND b.deleted_at IS NULL
			  AND COALESCE(cfg.hours, $4) > 0
			  AND b.starts_at > now()
			  AND b.starts_at <= now() + make_interval(hours => COALESCE(cfg.hours, $4))
			  AND b.created_at < b.starts_at - make_interval(hours => COALESCE(cfg.hours, $4))
			ORDER BY b.starts_at
			LIMIT $5
			FOR UPDATE OF b SKIP LOCKED`,
			SettingsKey, uuid.Nil, BookingConfirmed, DefaultReminderHours, reminderBatch)
		if err != nil {
			return err
		}
		var due []EventBooking
		for rows.Next() {
			var b EventBooking
			if err := rows.Scan(&b.ID, &b.TenantID, &b.EventID, &b.Seats, &b.Email, &b.Name, &b.UserID, &b.CancelToken, &b.StartsAt); err != nil {
				rows.Close()
				return err
			}
			due = append(due, b)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		for _, b := range due {
			ev := Event{TenantID: b.TenantID}
			if err := tx.QueryRow(ctx, `SELECT name, location, timezone FROM event WHERE id = $1`, b.EventID).
				Scan(&ev.Name, &ev.Location, &ev.Timezone); err != nil {
				return fmt.Errorf("event: reminder %s: %w", b.ID, err)
			}
			msg, err := bookingEmail(ctx, tx, TemplateReminder, ev, b, *b.StartsAt, s.siteURL)
			if err != nil {
				return err
			}
			// An unsendable address is still stamped: retrying it every sweep would stall the batch.
			if err := eerpmail.Enqueue(ctx, tx, msg); err != nil && !errors.Is(err, eerpmail.ErrInvalidMessage) {
				return err
			}
			if _, err := tx.Exec(ctx, `UPDATE event_booking SET reminder_sent_at = $2, updated_at = now() WHERE id = $1`, b.ID, time.Now()); err != nil {
				return err
			}
			sent++
		}
		return nil
	})
	return sent, err
}
