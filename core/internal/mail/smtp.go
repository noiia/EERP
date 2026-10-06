package mail

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/mail"
	"net/smtp"
	"strconv"
	"time"

	"core/internal/types"
)

// Transport delivers one outbox row. SMTPTransport in production; tests fake it.
type Transport interface {
	Send(ctx context.Context, o Outbox) error
}

// Configured reports whether SMTP delivery is set up.
func Configured(cfg *types.Config) bool { return cfg.SMTPHost != "" }

type SMTPTransport struct {
	host, user, password, from, tlsMode string
	port                                int
}

func NewSMTPTransport(cfg *types.Config) *SMTPTransport {
	port := cfg.SMTPPort
	if port == 0 {
		port = 587
		if cfg.SMTPTLS == "implicit" {
			port = 465
		}
	}
	mode := cfg.SMTPTLS
	if mode == "" {
		mode = "starttls"
	}
	return &SMTPTransport{host: cfg.SMTPHost, port: port, user: smtpLogin(cfg), password: cfg.SMTPPassword, from: cfg.SMTPFrom, tlsMode: mode}
}

// smtpLogin is the AUTH user: smtp_user, else — when a password is set —
// smtp_from's address, the login of a mailbox at most providers (OVH, Gmail,
// Microsoft 365…). "" means no AUTH (a local catcher or an open relay).
func smtpLogin(cfg *types.Config) string {
	if cfg.SMTPUser != "" || cfg.SMTPPassword == "" {
		return cfg.SMTPUser
	}
	return envelopeAddress(cfg.SMTPFrom)
}

// localSMTPHost: a catcher on this machine or in the Compose network, where
// plaintext and no AUTH are expected (Go's PLAIN auth allows clear text only
// to localhost).
func localSMTPHost(host string) bool {
	if host == "localhost" || host == "mailpit" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// Send dials, optionally upgrades to TLS, authenticates when a user is set,
// and submits one message. One connection per message: volumes are small
// (confirmations), and it keeps failure handling per-row.
func (s *SMTPTransport) Send(ctx context.Context, o Outbox) error {
	raw, err := buildMessage(s.from, o, time.Now())
	if err != nil {
		return err
	}
	addr := net.JoinHostPort(s.host, strconv.Itoa(s.port))
	dialer := &net.Dialer{Timeout: 15 * time.Second}
	tlsCfg := &tls.Config{ServerName: s.host, MinVersion: tls.VersionTLS12}
	var conn net.Conn
	if s.tlsMode == "implicit" {
		conn, err = (&tls.Dialer{NetDialer: dialer, Config: tlsCfg}).DialContext(ctx, "tcp", addr)
	} else {
		conn, err = dialer.DialContext(ctx, "tcp", addr)
	}
	if err != nil {
		return fmt.Errorf("smtp dial: %w", err)
	}
	deadline := time.Now().Add(60 * time.Second)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	_ = conn.SetDeadline(deadline)
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	c, err := smtp.NewClient(conn, s.host)
	if err != nil {
		_ = conn.Close()
		return fmt.Errorf("smtp hello: %w", err)
	}
	defer func() { _ = c.Close() }()
	if s.tlsMode == "starttls" {
		if ok, _ := c.Extension("STARTTLS"); !ok {
			return fmt.Errorf("smtp: server does not offer STARTTLS (set smtp_tls to \"none\" only for a local catcher)")
		}
		if err := c.StartTLS(tlsCfg); err != nil {
			return fmt.Errorf("smtp starttls: %w", err)
		}
	}
	if s.user != "" { // plaintext to a remote host is refused at boot (ValidateConfig)
		if err := c.Auth(smtp.PlainAuth("", s.user, s.password, s.host)); err != nil {
			return fmt.Errorf("smtp auth: %w", err)
		}
	}
	if err := c.Mail(envelopeAddress(s.from)); err != nil {
		if s.user == "" {
			return fmt.Errorf("smtp MAIL FROM: %w (no credentials are configured: set smtp_password, and smtp_user if the login isn't smtp_from's address)", err)
		}
		return fmt.Errorf("smtp MAIL FROM: %w", err)
	}
	if err := c.Rcpt(o.ToAddress); err != nil {
		return fmt.Errorf("smtp RCPT TO: %w", err)
	}
	w, err := c.Data()
	if err != nil {
		return fmt.Errorf("smtp DATA: %w", err)
	}
	if _, err := w.Write(raw); err != nil {
		return fmt.Errorf("smtp write: %w", err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("smtp end of data: %w", err)
	}
	// The relay accepted the message; a failed QUIT must not trigger a retry (duplicate).
	_ = c.Quit()
	return nil
}

// envelopeAddress strips a display name: "EERP <a@b.io>" → "a@b.io".
func envelopeAddress(from string) string {
	if a, err := mailAddress(from); err == nil {
		return a
	}
	return from
}

// ValidateConfig rejects SMTP settings that would otherwise fail silently at
// send time: an unknown smtp_tls (treated as plaintext) or an unusable smtp_from.
func ValidateConfig(cfg *types.Config) error {
	if !Configured(cfg) {
		return nil
	}
	switch cfg.SMTPTLS {
	case "", "starttls", "implicit", "none":
	default:
		return fmt.Errorf("smtp_tls %q is invalid — use starttls, implicit or none", cfg.SMTPTLS)
	}
	if _, err := mail.ParseAddress(cfg.SMTPFrom); err != nil {
		return fmt.Errorf("smtp_from %q is not a valid address: %w", cfg.SMTPFrom, err)
	}
	if smtpLogin(cfg) != "" && cfg.SMTPTLS == "none" && !localSMTPHost(cfg.SMTPHost) {
		return fmt.Errorf("smtp_tls \"none\" would send the password in clear to %s — use \"starttls\" (port 587) or \"implicit\" (port 465)", cfg.SMTPHost)
	}
	return nil
}

// ConfigWarnings are SMTP settings that boot accepts but that likely fail
// at send time: a remote relay with no credentials (most refuse with
// "530 not authenticated").
func ConfigWarnings(cfg *types.Config) []string {
	if !Configured(cfg) || localSMTPHost(cfg.SMTPHost) || smtpLogin(cfg) != "" {
		return nil
	}
	return []string{"smtp_host " + cfg.SMTPHost + " is remote but no credentials are set: set smtp_password (the login defaults to smtp_from's address, or set smtp_user)"}
}
