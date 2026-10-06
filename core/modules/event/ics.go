package event

import (
	"bytes"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// iCalendar (RFC 5545) output for bookings and feeds. A booking keeps one UID
// (booking-<id>@eerp) across its emails, so the cancellation's METHOD:CANCEL
// removes the entry the confirmation added, in clients that honour it.

const (
	MethodPublish = "PUBLISH"
	MethodCancel  = "CANCEL"
)

// CalendarEvent is one VEVENT. Times are written in UTC.
type CalendarEvent struct {
	UID                            string
	Start, End                     time.Time
	Summary, Location, Description string
	URL                            string
	Sequence                       int
	Cancelled                      bool
}

// Calendar is one VCALENDAR document.
type Calendar struct {
	Method string // MethodPublish (default) or MethodCancel
	Name   string // X-WR-CALNAME, the name a subscribed feed shows
	Events []CalendarEvent
}

const icsTime = "20060102T150405Z"

var icsEscaper = strings.NewReplacer(`\`, `\\`, ";", `\;`, ",", `\,`, "\r\n", `\n`, "\n", `\n`, "\r", `\n`)

// Bytes renders the calendar with CRLF line ends and lines folded at 75 octets.
func (c Calendar) Bytes() []byte {
	var b bytes.Buffer
	line := func(name, value string) { writeFolded(&b, name+":"+value) }
	method := c.Method
	if method == "" {
		method = MethodPublish
	}
	line("BEGIN", "VCALENDAR")
	line("VERSION", "2.0")
	line("PRODID", "-//EERP//Events//EN")
	line("CALSCALE", "GREGORIAN")
	line("METHOD", method)
	if c.Name != "" {
		line("X-WR-CALNAME", icsEscaper.Replace(c.Name))
	}
	stamp := time.Now().UTC().Format(icsTime)
	for _, e := range c.Events {
		line("BEGIN", "VEVENT")
		line("UID", e.UID+"@eerp")
		line("DTSTAMP", stamp)
		line("DTSTART", e.Start.UTC().Format(icsTime))
		line("DTEND", e.End.UTC().Format(icsTime))
		line("SEQUENCE", strconv.Itoa(e.Sequence))
		if e.Summary != "" {
			line("SUMMARY", icsEscaper.Replace(e.Summary))
		}
		if e.Location != "" {
			line("LOCATION", icsEscaper.Replace(e.Location))
		}
		if e.Description != "" {
			line("DESCRIPTION", icsEscaper.Replace(e.Description))
		}
		if e.URL != "" {
			line("URL", e.URL)
		}
		status := "CONFIRMED"
		if e.Cancelled {
			status = "CANCELLED"
		}
		line("STATUS", status)
		line("END", "VEVENT")
	}
	line("END", "VCALENDAR")
	return b.Bytes()
}

// writeFolded writes s, folded into lines of at most 75 octets (continuations
// start with a space), never splitting a UTF-8 character.
func writeFolded(b *bytes.Buffer, s string) {
	limit := 75
	for len(s) > limit {
		cut := limit
		for cut > 0 && !utf8.RuneStart(s[cut]) {
			cut--
		}
		b.WriteString(s[:cut] + "\r\n ")
		s = s[cut:]
		limit = 74 // the leading space counts
	}
	b.WriteString(s + "\r\n")
}
