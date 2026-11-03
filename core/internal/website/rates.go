package website

import (
	"context"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"sync"
	"time"

	"core/internal/common"

	"go.uber.org/zap"
)

// ECBDailyURL is the European Central Bank's daily reference rates feed: free,
// keyless, about 30 currencies against the euro, published once a working day.
const ECBDailyURL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml"

// LiveRates is the process-wide cache of the latest exchange rates (1 EUR =
// rate units of each currency). It never fetches on a request path: Run
// refreshes it in the background, and readers get whatever it holds — empty
// until the first fetch succeeded, which the site reads as "no conversion".
type LiveRates struct {
	fetch func(ctx context.Context) (map[string]float64, string, error)

	mu    sync.RWMutex
	rates map[string]float64
	date  string
}

// NewLiveRates reads from the ECB feed at url.
func NewLiveRates(url string) *LiveRates {
	client := &http.Client{Timeout: 10 * time.Second}
	return &LiveRates{fetch: func(ctx context.Context) (map[string]float64, string, error) {
		return fetchECB(ctx, client, url)
	}}
}

// Snapshot returns the cached rates (EUR = 1 included once fetched) and the
// feed's date. The map is a copy.
func (l *LiveRates) Snapshot() (map[string]float64, string) {
	if l == nil {
		return nil, ""
	}
	l.mu.RLock()
	defer l.mu.RUnlock()
	out := make(map[string]float64, len(l.rates))
	for k, v := range l.rates {
		out[k] = v
	}
	return out, l.date
}

// Refresh fetches once; a failure keeps the previous rates.
func (l *LiveRates) Refresh(ctx context.Context) error {
	rates, date, err := l.fetch(ctx)
	if err != nil {
		return err
	}
	rates["EUR"] = 1
	l.mu.Lock()
	l.rates, l.date = rates, date
	l.mu.Unlock()
	return nil
}

// Run refreshes now, then every 6 hours (15 minutes after a failure) until
// ctx ends. The feed changes once a day; 6 h keeps a fresh day within reach.
func (l *LiveRates) Run(ctx context.Context) {
	for {
		wait := 6 * time.Hour
		if err := l.Refresh(ctx); err != nil {
			common.Logger.Warn("website: exchange rates refresh failed", zap.Error(err))
			wait = 15 * time.Minute
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
	}
}

type ecbEnvelope struct {
	Days []struct {
		Time  string `xml:"time,attr"`
		Rates []struct {
			Currency string `xml:"currency,attr"`
			Rate     string `xml:"rate,attr"`
		} `xml:"Cube"`
	} `xml:"Cube>Cube"`
}

func fetchECB(ctx context.Context, client *http.Client, url string) (map[string]float64, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, "", err
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		return nil, "", fmt.Errorf("ecb rates: status %d", res.StatusCode)
	}
	return parseECB(io.LimitReader(res.Body, 1<<20))
}

func parseECB(r io.Reader) (map[string]float64, string, error) {
	var env ecbEnvelope
	if err := xml.NewDecoder(r).Decode(&env); err != nil {
		return nil, "", fmt.Errorf("ecb rates: %w", err)
	}
	if len(env.Days) == 0 {
		return nil, "", fmt.Errorf("ecb rates: no rates in the feed")
	}
	day := env.Days[0]
	rates := map[string]float64{}
	for _, c := range day.Rates {
		v, err := strconv.ParseFloat(c.Rate, 64)
		if err == nil && v > 0 && currencyCode.MatchString(c.Currency) {
			rates[c.Currency] = v
		}
	}
	if len(rates) == 0 {
		return nil, "", fmt.Errorf("ecb rates: no rates in the feed")
	}
	return rates, day.Time, nil
}

// relativeTo turns EUR-based rates into rates against base (1 base = r code).
// A base the feed doesn't quote gives nothing: no conversion beats a wrong one.
func relativeTo(eurRates map[string]float64, base string) map[string]float64 {
	b, ok := eurRates[base]
	if !ok || b <= 0 {
		return map[string]float64{}
	}
	out := make(map[string]float64, len(eurRates))
	for code, r := range eurRates {
		out[code] = r / b
	}
	return out
}
