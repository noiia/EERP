package website

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"core/internal/auth"
	"core/internal/settings"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

const ecbSample = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
	<gesmes:subject>Reference rates</gesmes:subject>
	<Cube>
		<Cube time='2026-11-02'>
			<Cube currency='USD' rate='1.1000'/>
			<Cube currency='GBP' rate='0.8000'/>
			<Cube currency='bad' rate='2'/>
		</Cube>
	</Cube>
</gesmes:Envelope>`

func TestParseECB(t *testing.T) {
	rates, date, err := parseECB(strings.NewReader(ecbSample))
	if err != nil {
		t.Fatal(err)
	}
	if date != "2026-11-02" || rates["USD"] != 1.1 || rates["GBP"] != 0.8 || len(rates) != 2 {
		t.Errorf("got %v on %q", rates, date)
	}
	if _, _, err := parseECB(strings.NewReader(`<Envelope/>`)); err == nil {
		t.Error("an empty feed must be an error, not empty rates")
	}
}

func TestRelativeTo(t *testing.T) {
	eur := map[string]float64{"EUR": 1, "USD": 1.1, "GBP": 0.8}
	got := relativeTo(eur, "GBP")
	if math.Abs(got["USD"]-1.375) > 1e-9 || got["GBP"] != 1 || math.Abs(got["EUR"]-1.25) > 1e-9 {
		t.Errorf("relativeTo(GBP) = %v", got)
	}
	if len(relativeTo(eur, "XAF")) != 0 {
		t.Error("an unquoted base must give no rates")
	}
}

func TestLocalization_Validate(t *testing.T) {
	cases := []struct {
		name    string
		l       Localization
		wantErr bool
	}{
		{"empty", Localization{}, false},
		{"typical", Localization{DefaultLocale: "fr", DefaultCurrency: "USD", Currencies: []string{"USD", "GBP"}, Overrides: map[string]float64{"GBP": 0.9}}, false},
		{"default is the base", Localization{DefaultCurrency: "EUR"}, false},
		{"lowercase code", Localization{Currencies: []string{"usd"}}, true},
		{"base listed again", Localization{Currencies: []string{"EUR"}}, true},
		{"duplicate", Localization{Currencies: []string{"USD", "USD"}}, true},
		{"default not offered", Localization{DefaultCurrency: "JPY"}, true},
		{"override not offered", Localization{Overrides: map[string]float64{"USD": 1}}, true},
		{"zero rate", Localization{Currencies: []string{"USD"}, Overrides: map[string]float64{"USD": 0}}, true},
		{"bad locale", Localization{DefaultLocale: "<fr>"}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tc.l.normalize()
			if err := tc.l.validate("EUR"); (err != nil) != tc.wantErr {
				t.Errorf("validate() = %v, wantErr %v", err, tc.wantErr)
			}
		})
	}
}

func fixedRates(r map[string]float64) *LiveRates {
	l := &LiveRates{fetch: func(context.Context) (map[string]float64, string, error) { return r, "2026-11-02", nil }}
	_ = l.Refresh(context.Background())
	return l
}

func TestLocalization_Resolve(t *testing.T) {
	company := uuid.New()
	tenant := uuid.New()
	eurCompany := func(context.Context, uuid.UUID) (uuid.UUID, string, error) { return company, "EUR", nil }
	store := memStore{
		LocalizationKey:        `{"default_locale":"fr","default_currency":"USD","currencies":["USD","GBP","CHF"],"overrides":{"GBP":0.75}}`,
		settings.DateFormatKey: "dd/MM/yyyy",
	}
	h := NewLocalizationHandler(store, tenant, eurCompany, fixedRates(map[string]float64{"USD": 1.1, "GBP": 0.8}))
	got, err := h.Resolve(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	// CHF has neither a live rate nor an override: not offered.
	want := PublicLocalization{
		DefaultLocale: "fr", DefaultCurrency: "USD", Base: "EUR",
		Rates:      map[string]float64{"EUR": 1, "USD": 1.1, "GBP": 0.75},
		Currencies: []string{"EUR", "USD", "GBP"}, DateFormat: "dd/MM/yyyy",
	}
	gotJSON, _ := json.Marshal(got)
	wantJSON, _ := json.Marshal(want)
	if string(gotJSON) != string(wantJSON) {
		t.Errorf("Resolve() =\n %s\nwant\n %s", gotJSON, wantJSON)
	}

	t.Run("no rates yet: only the base, default falls back to it", func(t *testing.T) {
		h := NewLocalizationHandler(store, tenant, eurCompany, &LiveRates{fetch: func(context.Context) (map[string]float64, string, error) {
			return nil, "", errors.New("offline")
		}})
		got, err := h.Resolve(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if got.DefaultCurrency != "EUR" || len(got.Currencies) != 2 || got.Rates["GBP"] != 0.75 {
			t.Errorf("got %+v, want EUR + the GBP override only", got)
		}
	})
}

func TestLocalizationHandler_PutGet(t *testing.T) {
	tenant := uuid.New()
	store := memStore{}
	h := NewLocalizationHandler(store, tenant, func(context.Context, uuid.UUID) (uuid.UUID, string, error) {
		return uuid.New(), "EUR", nil
	}, fixedRates(map[string]float64{"USD": 1.1}))
	call := func(fn echo.HandlerFunc, method, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "/", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req = req.WithContext(auth.SetIdentity(req.Context(), auth.Identity{TenantID: tenant}))
		rec := httptest.NewRecorder()
		if err := fn(echo.New().NewContext(req, rec)); err != nil {
			var he *echo.HTTPError
			if !errors.As(err, &he) {
				t.Fatal(err)
			}
			rec.Code = he.Code
		}
		return rec
	}
	if rec := call(h.Put, http.MethodPut, `{"currencies":["eur"]}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid PUT = %d, want 400", rec.Code)
	}
	if rec := call(h.Put, http.MethodPut, `{"currencies":["USD"],"overrides":{"USD":1.05}}`); rec.Code != http.StatusNoContent {
		t.Fatalf("PUT = %d, want 204", rec.Code)
	}
	rec := call(h.Get, http.MethodGet, "")
	var got localizationView
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Base != "EUR" || got.Live["USD"] != 1.1 || got.Overrides["USD"] != 1.05 || got.LiveDate != "2026-11-02" {
		t.Errorf("GET = %+v", got)
	}
}
