package providers

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

// ErrOIDC wraps every rejected OIDC exchange (bad token, PKCE, claims).
var ErrOIDC = errors.New("providers: oidc sign-in rejected")

type OIDCClient struct {
	http  *http.Client
	mu    sync.Mutex
	cache map[string]*oidc.Provider // by issuer
}

func NewOIDCClient(httpClient *http.Client) *OIDCClient {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 10 * time.Second}
	}
	return &OIDCClient{http: httpClient, cache: map[string]*oidc.Provider{}}
}

func (o *OIDCClient) provider(ctx context.Context, issuer string) (*oidc.Provider, error) {
	o.mu.Lock()
	p, ok := o.cache[issuer]
	o.mu.Unlock()
	if ok {
		return p, nil
	}
	p, err := oidc.NewProvider(oidc.ClientContext(ctx, o.http), issuer) // network call: no lock held
	if err != nil {
		return nil, fmt.Errorf("oidc: discovery %s: %w", issuer, err)
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	if first, ok := o.cache[issuer]; ok {
		return first, nil
	}
	o.cache[issuer] = p
	return p, nil
}

func scopes(p OIDCProvider) []string {
	s := strings.Fields(p.Scopes)
	if len(s) == 0 {
		s = []string{"profile", "email"}
	}
	return append([]string{oidc.ScopeOpenID}, s...)
}

func (o *OIDCClient) config(ctx context.Context, p OIDCProvider, redirectURI string) (*oauth2.Config, *oidc.Provider, error) {
	prov, err := o.provider(ctx, p.Issuer)
	if err != nil {
		return nil, nil, err
	}
	return &oauth2.Config{ClientID: p.ClientID, ClientSecret: p.ClientSecret, Endpoint: prov.Endpoint(),
		RedirectURL: redirectURI, Scopes: scopes(p)}, prov, nil
}

func (o *OIDCClient) Check(ctx context.Context, p OIDCProvider) error {
	_, err := o.provider(ctx, p.Issuer)
	return err
}

func (o *OIDCClient) AuthorizeURL(ctx context.Context, p OIDCProvider, redirectURI, state, nonce, challenge string) (string, error) {
	cfg, _, err := o.config(ctx, p, redirectURI)
	if err != nil {
		return "", err
	}
	return cfg.AuthCodeURL(state, oidc.Nonce(nonce),
		oauth2.SetAuthURLParam("code_challenge", challenge),
		oauth2.SetAuthURLParam("code_challenge_method", "S256")), nil
}

func (o *OIDCClient) Exchange(ctx context.Context, p OIDCProvider, code, verifier, redirectURI, nonce string) (ExternalIdentity, error) {
	if nonce == "" {
		return ExternalIdentity{}, fmt.Errorf("%w: missing nonce", ErrOIDC)
	}
	ctx = oidc.ClientContext(ctx, o.http)
	cfg, prov, err := o.config(ctx, p, redirectURI)
	if err != nil {
		return ExternalIdentity{}, err
	}
	tok, err := cfg.Exchange(ctx, code, oauth2.VerifierOption(verifier))
	if err != nil {
		return ExternalIdentity{}, fmt.Errorf("%w: token exchange: %v", ErrOIDC, err)
	}
	raw, ok := tok.Extra("id_token").(string)
	if !ok {
		return ExternalIdentity{}, fmt.Errorf("%w: no id_token", ErrOIDC)
	}
	idt, err := prov.Verifier(&oidc.Config{ClientID: p.ClientID}).Verify(ctx, raw)
	if err != nil {
		return ExternalIdentity{}, fmt.Errorf("%w: %v", ErrOIDC, err)
	}
	if idt.Nonce != nonce {
		return ExternalIdentity{}, fmt.Errorf("%w: nonce mismatch", ErrOIDC)
	}
	var claims map[string]any
	if err := idt.Claims(&claims); err != nil {
		return ExternalIdentity{}, fmt.Errorf("%w: claims: %v", ErrOIDC, err)
	}
	str := func(k string) string { s, _ := claims[k].(string); return s }
	verified, _ := claims["email_verified"].(bool)
	return ExternalIdentity{
		Provider: "oidc:" + p.ID, Subject: idt.Subject, Email: str("email"),
		EmailVerified: verified || p.TrustEmail, DisplayName: str("name"),
		Groups: claimList(claims[p.GroupsClaim]),
	}, nil
}

// claimList reads a groups claim given as an array or a single string.
func claimList(v any) []string {
	switch t := v.(type) {
	case string:
		return []string{t}
	case []any:
		out := make([]string, 0, len(t))
		for _, e := range t {
			if s, ok := e.(string); ok {
				out = append(out, s)
			}
		}
		return out
	}
	return nil
}
