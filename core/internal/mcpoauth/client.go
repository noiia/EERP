package mcpoauth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"
)

// ClientInfo is what EERP knows of a client, from its metadata document or its
// registration.
type ClientInfo struct {
	ID           string
	Name         string
	Host         string // where it comes from: shown on the consent page beside the claimed name
	RedirectURIs []string
}

const (
	metadataMaxBytes = 64 << 10
	metadataTimeout  = 5 * time.Second
	metadataCacheTTL = time.Hour
	metadataCacheCap = 256
	nameMaxRunes     = 200
)

var errUnknownClient = errors.New("unknown client")

// clientFinder reads a dynamically registered client.
type clientFinder interface {
	FindClient(ctx context.Context, clientID string) (Client, error)
}

// resolver turns a client_id into ClientInfo: an https client_id is a CIMD URL,
// fetched (cached an hour), anything else a registered client.
type resolver struct {
	s      Settings
	store  clientFinder
	http   *http.Client
	mu     sync.Mutex
	cached map[string]cachedClient
}

type cachedClient struct {
	info ClientInfo
	at   time.Time
}

func newResolver(s Settings, store clientFinder, client *http.Client) *resolver {
	return &resolver{s: s, store: store, http: client, cached: map[string]cachedClient{}}
}

func (r *resolver) resolve(ctx context.Context, clientID string) (ClientInfo, error) {
	if strings.HasPrefix(clientID, "https://") {
		return r.fetch(ctx, clientID)
	}
	c, err := r.store.FindClient(ctx, clientID)
	if err != nil {
		return ClientInfo{}, err
	}
	var uris []string
	if err := json.Unmarshal([]byte(c.RedirectURIs), &uris); err != nil {
		return ClientInfo{}, fmt.Errorf("client %s: redirect uris: %w", clientID, err)
	}
	host := ""
	if len(uris) > 0 {
		if u, err := url.Parse(uris[0]); err == nil {
			host = u.Hostname()
		}
	}
	return ClientInfo{ID: c.ClientID, Name: c.Name, Host: host, RedirectURIs: uris}, nil
}

// trustedURI reports whether raw is an https URL without credentials or fragment
// on a host the operator trusts: the rule for metadata URLs and redirect URIs.
func (r *resolver) trustedURI(raw string) (*url.URL, bool) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Fragment != "" || u.Hostname() == "" {
		return nil, false
	}
	return u, r.s.TrustedHosts[strings.ToLower(u.Hostname())]
}

// fetch reads a Client ID Metadata Document: from a trusted host only, over a
// connection that refuses private addresses, no redirects, at most 64 KiB.
func (r *resolver) fetch(ctx context.Context, clientID string) (ClientInfo, error) {
	u, ok := r.trustedURI(clientID)
	if !ok || u.Path == "" || u.Path == "/" {
		return ClientInfo{}, fmt.Errorf("client metadata URL %q is not on a trusted host", clientID)
	}
	r.mu.Lock()
	if c, hit := r.cached[clientID]; hit && time.Since(c.at) < metadataCacheTTL {
		r.mu.Unlock()
		return c.info, nil
	}
	r.mu.Unlock()

	ctx, cancel := context.WithTimeout(ctx, metadataTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, clientID, nil)
	if err != nil {
		return ClientInfo{}, err
	}
	req.Header.Set("Accept", "application/json")
	res, err := r.http.Do(req)
	if err != nil {
		return ClientInfo{}, fmt.Errorf("client metadata: %w", err)
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		return ClientInfo{}, fmt.Errorf("client metadata: status %d", res.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, metadataMaxBytes+1))
	if err != nil {
		return ClientInfo{}, fmt.Errorf("client metadata: %w", err)
	}
	if len(body) > metadataMaxBytes {
		return ClientInfo{}, errors.New("client metadata: document too large")
	}
	var doc struct {
		ClientID     string   `json:"client_id"`
		ClientName   string   `json:"client_name"`
		RedirectURIs []string `json:"redirect_uris"`
		AuthMethod   string   `json:"token_endpoint_auth_method"`
		AuthMethods  []string `json:"token_endpoint_auth_methods_supported"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		return ClientInfo{}, fmt.Errorf("client metadata: %w", err)
	}
	if doc.ClientID != clientID {
		return ClientInfo{}, errors.New("client metadata: client_id does not match its URL")
	}
	// A client may prefer another method (ChatGPT declares private_key_jwt) as long as it
	// can be a public client: EERP's metadata offers "none" only, so that is what it uses.
	if doc.AuthMethod != "" && doc.AuthMethod != "none" && !slices.Contains(doc.AuthMethods, "none") {
		return ClientInfo{}, errors.New("client metadata: only public clients (token_endpoint_auth_method none) are supported")
	}
	if err := r.checkRedirectURIs(doc.RedirectURIs); err != nil {
		return ClientInfo{}, err
	}
	info := ClientInfo{ID: clientID, Name: clientName(doc.ClientName, u.Hostname()), Host: u.Hostname(), RedirectURIs: doc.RedirectURIs}
	r.mu.Lock()
	if len(r.cached) >= metadataCacheCap {
		r.cached = map[string]cachedClient{}
	}
	r.cached[clientID] = cachedClient{info: info, at: time.Now()}
	r.mu.Unlock()
	return info, nil
}

func (r *resolver) checkRedirectURIs(uris []string) error {
	if len(uris) == 0 || len(uris) > 10 {
		return errors.New("between 1 and 10 redirect URIs are required")
	}
	for _, raw := range uris {
		_, trusted := r.trustedURI(raw)
		if (!trusted && loopback(raw) == nil) || len(raw) > 2000 {
			return fmt.Errorf("redirect URI %q is neither an https URL on a trusted host nor a loopback one", raw)
		}
	}
	return nil
}

// loopback parses a native app's callback (RFC 8252 §7.3): plain http to this machine
// (localhost, 127.0.0.1, [::1]), as Claude Code and Claude Desktop's mcp-remote use. A code
// sent there reaches only a program on the user's own computer. nil when raw isn't one.
func loopback(raw string) *url.URL {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "http" || u.User != nil || u.Fragment != "" {
		return nil
	}
	switch u.Hostname() {
	case "localhost", "127.0.0.1", "::1":
		return u
	}
	return nil
}

// redirectAllowed reports whether a request's redirect URI is one the client registered:
// exactly, or, for a loopback callback, the same URL on any port (the app listens on a
// port it picks for each sign-in, RFC 8252 §7.3).
func redirectAllowed(registered []string, uri string) bool {
	if slices.Contains(registered, uri) {
		return true
	}
	got := loopback(uri)
	if got == nil {
		return false
	}
	for _, r := range registered {
		if want := loopback(r); want != nil && want.Hostname() == got.Hostname() &&
			want.EscapedPath() == got.EscapedPath() && want.RawQuery == got.RawQuery {
			return true
		}
	}
	return false
}

// clientName is the claimed name, trimmed to 200 characters, else the host.
func clientName(name, host string) string {
	name = strings.TrimSpace(name)
	if r := []rune(name); len(r) > nameMaxRunes {
		name = string(r[:nameMaxRunes])
	}
	if name == "" {
		return host
	}
	return name
}

// publicHTTPClient fetches metadata documents: it dials public addresses only
// (checked on the resolved IP, so DNS can't point it inside the network) and
// never follows a redirect.
func publicHTTPClient() *http.Client {
	dialer := &net.Dialer{Timeout: metadataTimeout, Control: func(_, address string, _ syscall.RawConn) error {
		host, _, err := net.SplitHostPort(address)
		if err != nil {
			return err
		}
		if ip := net.ParseIP(host); ip == nil || !publicIP(ip) {
			return fmt.Errorf("refusing to fetch client metadata from %s", host)
		}
		return nil
	}}
	return &http.Client{
		Timeout:       metadataTimeout,
		Transport:     &http.Transport{DialContext: dialer.DialContext, TLSHandshakeTimeout: metadataTimeout, MaxResponseHeaderBytes: 16 << 10},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

// carrierNAT is 100.64.0.0/10 (RFC 6598), which IsPrivate leaves out.
var carrierNAT = &net.IPNet{IP: net.IPv4(100, 64, 0, 0), Mask: net.CIDRMask(10, 32)}

func publicIP(ip net.IP) bool {
	return ip.IsGlobalUnicast() && !ip.IsPrivate() && !ip.IsLoopback() && !ip.IsLinkLocalUnicast() &&
		!ip.IsUnspecified() && !ip.IsMulticast() && !ip.IsInterfaceLocalMulticast() && !carrierNAT.Contains(ip)
}
