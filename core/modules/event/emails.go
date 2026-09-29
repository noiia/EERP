package event

import (
	htmltpl "html/template"
	"strings"
	texttpl "text/template"
	"time"

	eerpmail "core/internal/mail"
)

// English copy in v1; per-locale templates are a follow-up.

type emailData struct {
	Event, Name, When, Location, CancelURL string
	Seats                                  int
}

var (
	confirmText = texttpl.Must(texttpl.New("t").Parse(`Hello {{.Name}},

Your booking is confirmed.

Event: {{.Event}}
When: {{.When}}
Seats: {{.Seats}}
{{if .Location}}Location: {{.Location}}
{{end}}
To cancel: {{.CancelURL}}
`))
	confirmHTML = htmltpl.Must(htmltpl.New("h").Parse(`<p>Hello {{.Name}},</p>
<p>Your booking is confirmed.</p>
<ul>
<li>Event: {{.Event}}</li>
<li>When: {{.When}}</li>
<li>Seats: {{.Seats}}</li>
{{if .Location}}<li>Location: {{.Location}}</li>{{end}}
</ul>
<p><a href="{{.CancelURL}}">Cancel this booking</a></p>
`))
	cancelText = texttpl.Must(texttpl.New("t").Parse(`Hello {{.Name}},

Your booking for {{.Event}} ({{.Seats}} seat(s)) has been cancelled.
`))
	cancelHTML = htmltpl.Must(htmltpl.New("h").Parse(`<p>Hello {{.Name}},</p>
<p>Your booking for {{.Event}} ({{.Seats}} seat(s)) has been cancelled.</p>
`))
)

// oneLine keeps staff-typed text from breaking a mail header.
var oneLine = strings.NewReplacer("\r\n", " ", "\r", " ", "\n", " ")

func render(d emailData, subject string, t *texttpl.Template, h *htmltpl.Template) (eerpmail.Message, error) {
	var text, html strings.Builder
	if err := t.Execute(&text, d); err != nil {
		return eerpmail.Message{}, err
	}
	if err := h.Execute(&html, d); err != nil {
		return eerpmail.Message{}, err
	}
	return eerpmail.Message{Subject: oneLine.Replace(subject), Text: text.String(), HTML: html.String()}, nil
}

func confirmationEmail(ev Event, b EventBooking, when time.Time, siteURL string) (eerpmail.Message, error) {
	rules, err := RulesFor(ev)
	if err != nil {
		return eerpmail.Message{}, err
	}
	d := emailData{Event: ev.Name, Name: b.Name, Seats: b.Seats,
		When:      when.In(rules.Loc).Format("Monday 2 January 2006, 15:04 MST"),
		CancelURL: siteURL + "/booking/cancel?token=" + b.CancelToken}
	if ev.Location != nil {
		d.Location = *ev.Location
	}
	msg, err := render(d, "Booking confirmed: "+ev.Name, confirmText, confirmHTML)
	msg.To = b.Email
	return msg, err
}

func cancellationEmail(eventName string, b EventBooking) (eerpmail.Message, error) {
	msg, err := render(emailData{Event: eventName, Name: b.Name, Seats: b.Seats}, "Booking cancelled", cancelText, cancelHTML)
	msg.To = b.Email
	return msg, err
}
