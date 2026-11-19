package event

import (
	"context"
	"maps"
	"strconv"
	"time"

	eerpmail "core/internal/mail"
	"core/orm"
)

// Booking emails are core mail templates (ADR-027): admins reword or
// translate them in Settings → Email templates; these are the defaults.
// Each goes out in the booker's account language, else the workspace's.

const (
	TemplateConfirmed = "event.booking_confirmed"
	TemplateReminder  = "event.booking_reminder"
	TemplateCancelled = "event.booking_cancelled"
	TemplateWaitlist  = "event.waitlist_joined"
	TemplateOffer     = "event.waitlist_offer"
)

var bookingVars = []string{"name", "event", "when", "seats", "location", "cancel_url"}

func init() {
	eerpmail.RegisterTemplate(eerpmail.TemplateDef{
		Key: TemplateConfirmed, Label: "Event booking confirmed", Vars: bookingVars,
		Defaults: map[string]eerpmail.Content{
			"en": {Subject: "Booking confirmed: {{event}}", HTML: `<p>Hello {{name}},</p><p>Your booking is confirmed.</p>` +
				`<ul><li>Event: {{event}}</li><li>When: {{when}}</li><li>Seats: {{seats}}</li><li>Where: {{location}}</li></ul>` +
				`<p><a href="{{cancel_url}}">Cancel this booking</a></p>`},
			"fr": {Subject: "Réservation confirmée : {{event}}", HTML: `<p>Bonjour {{name}},</p><p>Votre réservation est confirmée.</p>` +
				`<ul><li>Événement : {{event}}</li><li>Quand : {{when}}</li><li>Places : {{seats}}</li><li>Où : {{location}}</li></ul>` +
				`<p><a href="{{cancel_url}}">Annuler cette réservation</a></p>`},
		},
	})
	eerpmail.RegisterTemplate(eerpmail.TemplateDef{
		Key: TemplateReminder, Label: "Event booking reminder", Vars: bookingVars,
		Defaults: map[string]eerpmail.Content{
			"en": {Subject: "Reminder: {{event}}, {{when}}", HTML: `<p>Hello {{name}},</p><p>A reminder of your booking.</p>` +
				`<ul><li>Event: {{event}}</li><li>When: {{when}}</li><li>Seats: {{seats}}</li><li>Where: {{location}}</li></ul>` +
				`<p>Can't come any more? <a href="{{cancel_url}}">Cancel this booking</a> to free your seat.</p>`},
			"fr": {Subject: "Rappel : {{event}}, {{when}}", HTML: `<p>Bonjour {{name}},</p><p>Un rappel de votre réservation.</p>` +
				`<ul><li>Événement : {{event}}</li><li>Quand : {{when}}</li><li>Places : {{seats}}</li><li>Où : {{location}}</li></ul>` +
				`<p>Vous ne pouvez plus venir ? <a href="{{cancel_url}}">Annulez cette réservation</a> pour libérer votre place.</p>`},
		},
	})
	eerpmail.RegisterTemplate(eerpmail.TemplateDef{
		Key: TemplateCancelled, Label: "Event booking cancelled", Vars: []string{"name", "event", "seats"},
		Defaults: map[string]eerpmail.Content{
			"en": {Subject: "Booking cancelled: {{event}}", HTML: `<p>Hello {{name}},</p><p>Your booking for {{event}} ({{seats}} seat(s)) has been cancelled.</p>`},
			"fr": {Subject: "Réservation annulée : {{event}}", HTML: `<p>Bonjour {{name}},</p><p>Votre réservation pour {{event}} ({{seats}} place(s)) a été annulée.</p>`},
		},
	})
	eerpmail.RegisterTemplate(eerpmail.TemplateDef{
		Key: TemplateWaitlist, Label: "Event waiting list joined", Vars: bookingVars,
		Defaults: map[string]eerpmail.Content{
			"en": {Subject: "You're on the waiting list: {{event}}", HTML: `<p>Hello {{name}},</p>` +
				`<p>{{event}} on {{when}} is full; you're on the waiting list for {{seats}} seat(s). ` +
				`We'll email you as soon as a seat is free.</p><p><a href="{{cancel_url}}">Leave the waiting list</a></p>`},
			"fr": {Subject: "Vous êtes sur la liste d'attente : {{event}}", HTML: `<p>Bonjour {{name}},</p>` +
				`<p>{{event}} le {{when}} est complet ; vous êtes sur la liste d'attente pour {{seats}} place(s). ` +
				`Nous vous écrirons dès qu'une place se libère.</p><p><a href="{{cancel_url}}">Quitter la liste d'attente</a></p>`},
		},
	})
	eerpmail.RegisterTemplate(eerpmail.TemplateDef{
		Key: TemplateOffer, Label: "Event waiting list: a seat is free", Vars: append(append([]string{}, bookingVars...), "claim_url", "expires"),
		Defaults: map[string]eerpmail.Content{
			"en": {Subject: "A seat is free: {{event}}", HTML: `<p>Hello {{name}},</p>` +
				`<p>A seat is free for {{event}} on {{when}}. Book it before {{expires}}:</p>` +
				`<p><a href="{{claim_url}}">Book my seat</a></p><p>First come, first served: if someone books it before you, you stay on the list.</p>`},
			"fr": {Subject: "Une place est libre : {{event}}", HTML: `<p>Bonjour {{name}},</p>` +
				`<p>Une place est libre pour {{event}} le {{when}}. Réservez-la avant le {{expires}} :</p>` +
				`<p><a href="{{claim_url}}">Réserver ma place</a></p><p>Premier arrivé, premier servi : si quelqu'un la réserve avant vous, vous restez sur la liste.</p>`},
		},
	})
}

// bookingEmail renders a booking template for b in its booker's language.
// extra adds template-specific variables (a claim link, an expiry).
func bookingEmail(ctx context.Context, ex orm.Executor, key string, ev Event, b EventBooking, when time.Time, siteURL string, extra ...func(locale string, loc *time.Location) map[string]string) (eerpmail.Message, error) {
	locale, err := eerpmail.ResolveLocale(ctx, ex, ev.TenantID, b.UserID)
	if err != nil {
		return eerpmail.Message{}, err
	}
	rules, err := RulesFor(ev)
	if err != nil {
		return eerpmail.Message{}, err
	}
	location := "—"
	if ev.Location != nil && *ev.Location != "" {
		location = *ev.Location
	}
	vars := map[string]string{
		"name": b.Name, "event": ev.Name, "seats": strconv.Itoa(b.Seats), "location": location,
		"when":       eerpmail.FormatDateTime(when.In(rules.Loc), locale),
		"cancel_url": siteURL + "/booking/cancel?token=" + b.CancelToken,
	}
	for _, more := range extra {
		maps.Copy(vars, more(locale, rules.Loc))
	}
	msg, err := eerpmail.Render(ctx, ex, ev.TenantID, key, locale, vars)
	msg.TenantID, msg.To = ev.TenantID, b.Email
	return msg, err
}

// confirmationEmail: amountDue ("24.00 EUR") picks the pay-at-the-event
// wording; "" the plain one. Either way it carries the calendar invite.
func confirmationEmail(ctx context.Context, ex orm.Executor, ev Event, b EventBooking, when time.Time, siteURL, amountDue string) (eerpmail.Message, error) {
	key, extra := TemplateConfirmed, []func(string, *time.Location) map[string]string{}
	if amountDue != "" {
		key = TemplateConfirmedPayLater
		extra = append(extra, func(string, *time.Location) map[string]string { return map[string]string{"amount": amountDue} })
	}
	msg, err := bookingEmail(ctx, ex, key, ev, b, when, siteURL, extra...)
	if err != nil {
		return msg, err
	}
	invite, err := bookingInvite(ctx, ex, ev, b, when, false)
	if err != nil {
		return msg, err
	}
	msg.Attachments = []eerpmail.Attachment{invite}
	return msg, nil
}

// cancellationEmail tells the booker; a confirmed booking's email carries the
// METHOD:CANCEL invite that removes the confirmation's calendar entry.
func cancellationEmail(ctx context.Context, ex orm.Executor, ev Event, b EventBooking, wasConfirmed bool) (eerpmail.Message, error) {
	var when time.Time
	if b.StartsAt != nil {
		when = *b.StartsAt
	}
	msg, err := bookingEmail(ctx, ex, TemplateCancelled, ev, b, when, "")
	if err != nil || !wasConfirmed || b.StartsAt == nil {
		return msg, err
	}
	invite, err := bookingInvite(ctx, ex, ev, b, when, true)
	if err != nil {
		return msg, err
	}
	msg.Attachments = []eerpmail.Attachment{invite}
	return msg, nil
}

// bookingInvite is the booking's .ics: one VEVENT with a UID stable across
// its emails (booking-<id>), so a later CANCEL removes the same entry.
func bookingInvite(ctx context.Context, ex orm.Executor, ev Event, b EventBooking, start time.Time, cancelled bool) (eerpmail.Attachment, error) {
	end, err := bookingEnd(ctx, ex, b, start)
	if err != nil {
		return eerpmail.Attachment{}, err
	}
	cal := Calendar{Method: MethodPublish, Events: []CalendarEvent{{
		UID: "booking-" + b.ID.String(), Start: start, End: end, Summary: ev.Name,
		Description: "Seats: " + strconv.Itoa(b.Seats),
	}}}
	if ev.Location != nil {
		cal.Events[0].Location = *ev.Location
	}
	ctype := "text/calendar; charset=utf-8; method=PUBLISH"
	if cancelled {
		cal.Method, cal.Events[0].Cancelled, cal.Events[0].Sequence = MethodCancel, true, 1
		ctype = "text/calendar; charset=utf-8; method=CANCEL"
	}
	return eerpmail.Attachment{Filename: "booking.ics", ContentType: ctype, Data: cal.Bytes()}, nil
}

// bookingEnd is when the booked session or slot ends (start + 1 h if unknown).
func bookingEnd(ctx context.Context, ex orm.Executor, b EventBooking, start time.Time) (time.Time, error) {
	if b.SlotEnd != nil {
		return *b.SlotEnd, nil
	}
	if b.SessionID != nil {
		var end time.Time
		err := ex.QueryRow(ctx, `SELECT ends_at FROM event_session WHERE id = $1`, *b.SessionID).Scan(&end)
		if err == nil {
			return end, nil
		}
		if !isNoRows(err) {
			return time.Time{}, err
		}
	}
	return start.Add(time.Hour), nil
}
