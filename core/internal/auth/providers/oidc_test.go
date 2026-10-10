package providers

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"core/orm/access"
	"github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
	"go.uber.org/zap"
	"go.uber.org/zap/zaptest/observer"
)

// fakeIdP is a minimal OIDC provider: discovery, JWKS, token endpoint.
type fakeIdP struct {
	srv      *httptest.Server
	key      *rsa.PrivateKey
	claims   map[string]any // ID token claims for the next code
	verifier string         // expected PKCE verifier
	wrongKey bool
}

func newFakeIdP(t *testing.T) *fakeIdP {
	f := &fakeIdP{}
	f.key, _ = rsa.GenerateKey(rand.Reader, 2048)
	mux := http.NewServeMux()
	f.srv = httptest.NewTLSServer(mux)
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"issuer": f.srv.URL, "authorization_endpoint": f.srv.URL + "/authorize",
			"token_endpoint": f.srv.URL + "/token", "jwks_uri": f.srv.URL + "/jwks",
			"id_token_signing_alg_values_supported": []string{"RS256"},
		})
	})
	mux.HandleFunc("/jwks", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: &f.key.PublicKey, KeyID: "k1", Algorithm: "RS256", Use: "sig"}}})
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		sum := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
		if base64.RawURLEncoding.EncodeToString(sum[:]) != f.verifier {
			http.Error(w, `{"error":"invalid_grant"}`, http.StatusBadRequest)
			return
		}
		signKey := f.key
		if f.wrongKey {
			signKey, _ = rsa.GenerateKey(rand.Reader, 2048)
		}
		signer, _ := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: signKey}, (&jose.SignerOptions{}).WithHeader("kid", "k1"))
		tok, _ := jwt.Signed(signer).Claims(f.claims).Serialize()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "at", "token_type": "Bearer", "id_token": tok})
	})
	t.Cleanup(f.srv.Close)
	return f
}

func pkce() (verifier, challenge string) {
	verifier = "verifier-" + strings.Repeat("x", 40)
	sum := sha256.Sum256([]byte(verifier))
	return verifier, base64.RawURLEncoding.EncodeToString(sum[:])
}

func TestOIDCExchange(t *testing.T) {
	idp := newFakeIdP(t)
	client := NewOIDCClient(idp.srv.Client())
	p := OIDCProvider{ID: "corp", Issuer: idp.srv.URL, ClientID: "erp", ClientSecret: "s", GroupsClaim: "groups"}
	ctx := context.Background()
	verifier, challenge := pkce()

	url, err := client.AuthorizeURL(ctx, p, "https://erp/api/auth/oidc/callback", "st", "n1", challenge)
	if err != nil || !strings.Contains(url, "code_challenge="+challenge) || !strings.Contains(url, "code_challenge_method=S256") || !strings.Contains(url, "nonce=n1") {
		t.Fatalf("authorize url = %q, %v", url, err)
	}

	base := func() map[string]any {
		return map[string]any{"iss": idp.srv.URL, "aud": "erp", "sub": "u-1", "exp": time.Now().Add(time.Hour).Unix(),
			"iat": time.Now().Unix(), "nonce": "n1", "email": "a@x", "email_verified": true, "name": "A", "groups": []string{"erp"}}
	}
	idp.verifier = challenge

	idp.claims = base()
	id, err := client.Exchange(ctx, p, "code", verifier, "https://erp/api/auth/oidc/callback", "n1")
	if err != nil || id.Subject != "u-1" || id.Provider != "oidc:corp" || !id.EmailVerified || len(id.Groups) != 1 {
		t.Fatalf("exchange = %+v, %v", id, err)
	}

	cases := map[string]func(map[string]any){
		"wrong audience": func(c map[string]any) { c["aud"] = "other" },
		"expired":        func(c map[string]any) { c["exp"] = time.Now().Add(-time.Hour).Unix() },
		"wrong nonce":    func(c map[string]any) { c["nonce"] = "n2" },
		"wrong issuer":   func(c map[string]any) { c["iss"] = "https://evil" },
	}
	for name, mutate := range cases {
		c := base()
		mutate(c)
		idp.claims = c
		if _, err := client.Exchange(ctx, p, "code", verifier, "https://erp/api/auth/oidc/callback", "n1"); !errors.Is(err, ErrOIDC) {
			t.Errorf("%s: err = %v, want ErrOIDC", name, err)
		}
	}
	idp.claims = base()
	idp.wrongKey = true
	if _, err := client.Exchange(ctx, p, "code", verifier, "https://erp/api/auth/oidc/callback", "n1"); !errors.Is(err, ErrOIDC) {
		t.Errorf("bad signature: err = %v", err)
	}
	idp.wrongKey = false
	if _, err := client.Exchange(ctx, p, "code", "not-the-verifier", "https://erp/api/auth/oidc/callback", "n1"); !errors.Is(err, ErrOIDC) {
		t.Errorf("PKCE mismatch: err = %v", err)
	}
	c := base()
	c["email_verified"] = false
	idp.claims = c
	if id, err := client.Exchange(ctx, p, "code", verifier, "https://erp/api/auth/oidc/callback", "n1"); err != nil || id.EmailVerified {
		t.Errorf("unverified email: %+v %v", id, err)
	}
	p.TrustEmail = true
	if id, _ := client.Exchange(ctx, p, "code", verifier, "https://erp/api/auth/oidc/callback", "n1"); !id.EmailVerified {
		t.Error("trust_email must mark the email verified")
	}
}

func oidcHandlerSetup(t *testing.T, idp *fakeIdP) (*Handler, *fakeSessions, uuid.UUID) {
	h, _ := newTestHandler(t, uuid.New())
	sessions := &fakeSessions{}
	user := uuid.New()
	h.deps.Sessions = sessions
	h.deps.OIDC = NewOIDCClient(idp.srv.Client())
	h.provision = func(context.Context, uuid.UUID, ExternalIdentity, Methods) (uuid.UUID, error) { return user, nil }
	m := Methods{Default: "oidc:corp", Enabled: []string{"oidc:corp"}, ERPURL: "https://erp.example.com",
		OIDC: []OIDCProvider{{ID: "corp", Label: "Corp", Issuer: idp.srv.URL, ClientID: "erp", ClientSecret: "s", GroupsClaim: "groups"},
			{ID: "off", Label: "Off", Issuer: idp.srv.URL, ClientID: "erp", ClientSecret: "s"}}}
	if err := h.deps.Store.Save(context.Background(), h.deps.Tenant, m); err != nil {
		t.Fatal(err)
	}
	return h, sessions, user
}

func callOIDC(t *testing.T, h *Handler, fn echo.HandlerFunc, id, method, target, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req = req.WithContext(access.WithTenant(req.Context(), h.deps.Tenant))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	c := echo.New().NewContext(req, rec)
	c.SetPathValues(echo.PathValues{{Name: "id", Value: id}})
	if err := fn(c); err != nil {
		he, ok := err.(*echo.HTTPError)
		if !ok {
			t.Fatal(err)
		}
		rec.Code = he.Code
	}
	return rec
}

func TestOIDCRoutes(t *testing.T) {
	idp := newFakeIdP(t)
	h, sessions, user := oidcHandlerSetup(t, idp)
	verifier, challenge := pkce()
	idp.verifier = challenge

	rec := callOIDC(t, h, h.OIDCAuthorize, "corp", http.MethodGet, "/?state=s&nonce=n1&code_challenge="+challenge, "")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "redirect_uri=https%3A%2F%2Ferp.example.com%2Fapi%2Fauth%2Foidc%2Fcallback") {
		t.Fatalf("authorize = %d %s", rec.Code, rec.Body.String())
	}
	if rec := callOIDC(t, h, h.OIDCAuthorize, "corp", http.MethodGet, "/?state=s", ""); rec.Code != http.StatusBadRequest {
		t.Errorf("missing params = %d", rec.Code)
	}
	for _, id := range []string{"off", "nope"} {
		if rec := callOIDC(t, h, h.OIDCAuthorize, id, http.MethodGet, "/?state=s&nonce=n1&code_challenge="+challenge, ""); rec.Code != http.StatusNotFound {
			t.Errorf("authorize %s = %d, want 404", id, rec.Code)
		}
	}

	claims := func(nonce string) map[string]any {
		return map[string]any{"iss": idp.srv.URL, "aud": "erp", "sub": "u-1", "exp": time.Now().Add(time.Hour).Unix(),
			"iat": time.Now().Unix(), "nonce": nonce, "email": "a@x", "email_verified": true}
	}
	body := `{"code":"c","code_verifier":"` + verifier + `","nonce":"n1"}`
	idp.claims = claims("n2")
	rec = callOIDC(t, h, h.OIDCExchange, "corp", http.MethodPost, "/", body)
	if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), "Sign-in failed.") || sessions.issued != uuid.Nil {
		t.Fatalf("wrong nonce = %d %s", rec.Code, rec.Body.String())
	}
	if rec := callOIDC(t, h, h.OIDCExchange, "off", http.MethodPost, "/", body); rec.Code != http.StatusUnauthorized {
		t.Errorf("disabled provider exchange = %d", rec.Code)
	}
	idp.claims = claims("n1")
	if rec := callOIDC(t, h, h.OIDCExchange, "corp", http.MethodPost, "/", body); rec.Code != http.StatusOK || sessions.issued != user {
		t.Fatalf("good exchange = %d %s", rec.Code, rec.Body.String())
	}
	sessions.issued = uuid.Nil
	h.provision = func(context.Context, uuid.UUID, ExternalIdentity, Methods) (uuid.UUID, error) {
		return uuid.Nil, ErrRefused
	}
	if rec := callOIDC(t, h, h.OIDCExchange, "corp", http.MethodPost, "/", body); rec.Code != http.StatusUnauthorized || sessions.issued != uuid.Nil {
		t.Errorf("refused provisioning = %d", rec.Code)
	}
}

func TestTestSettingsOIDC(t *testing.T) {
	idp := newFakeIdP(t)
	h, _, _ := oidcHandlerSetup(t, idp)
	rec := call(t, h, h.TestSettings, http.MethodPost, `{"method":"oidc:corp"}`)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"ok":true`) {
		t.Errorf("oidc test = %d %s", rec.Code, rec.Body.String())
	}
	if rec := call(t, h, h.TestSettings, http.MethodPost, `{"method":"oidc:nope"}`); rec.Code != http.StatusBadRequest {
		t.Errorf("unknown = %d", rec.Code)
	}
}

func TestOIDCRefusalsAreLogged(t *testing.T) {
	idp := newFakeIdP(t)
	h, _, _ := oidcHandlerSetup(t, idp)
	core, logs := observer.New(zap.DebugLevel)
	h.deps.Logger = zap.New(core)
	verifier, challenge := pkce()
	idp.verifier = challenge
	body := `{"code":"secret-auth-code","code_verifier":"` + verifier + `","nonce":"n1"}`
	claims := func(nonce string) map[string]any {
		return map[string]any{"iss": idp.srv.URL, "aud": "erp", "sub": "u-1", "exp": time.Now().Add(time.Hour).Unix(),
			"iat": time.Now().Unix(), "nonce": nonce, "email": "a@x", "email_verified": true}
	}
	idp.claims = claims("n2")
	callOIDC(t, h, h.OIDCExchange, "corp", http.MethodPost, "/", body)
	if logs.Len() != 1 || logs.All()[0].Level != zap.WarnLevel {
		t.Fatalf("rejection entries = %v", logs.All())
	}
	idp.claims = claims("n1")
	h.provision = func(context.Context, uuid.UUID, ExternalIdentity, Methods) (uuid.UUID, error) {
		return uuid.Nil, ErrRefused
	}
	callOIDC(t, h, h.OIDCExchange, "corp", http.MethodPost, "/", body)
	if logs.Len() != 2 || logs.All()[1].Level != zap.InfoLevel {
		t.Fatalf("refusal entries = %v", logs.All())
	}
	for _, e := range logs.All() {
		s := e.Message + " " + fmt.Sprint(e.ContextMap())
		if strings.Contains(s, "secret-auth-code") || strings.Contains(s, `"s"`) {
			t.Errorf("log leaks secret: %s", s)
		}
	}
}

func TestOIDCExchangeRefusesEmptyNonce(t *testing.T) {
	idp := newFakeIdP(t)
	p := OIDCProvider{ID: "corp", Issuer: idp.srv.URL, ClientID: "erp", ClientSecret: "s"}
	if _, err := NewOIDCClient(idp.srv.Client()).Exchange(context.Background(), p, "c", "v", "https://erp/cb", ""); !errors.Is(err, ErrOIDC) {
		t.Errorf("empty nonce err = %v", err)
	}
}
