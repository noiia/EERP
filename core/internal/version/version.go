// Package version reports which build of every EERP service is running: core
// itself (Version, stamped at build time) plus each separately deployed service
// registered with a probe (pdf-service today). Settings shows the list
// (GET /api/v1/versions) so an administrator can tell exactly what is deployed
// — services are built and shipped independently, so their versions can differ.
//
// Adding a service: make it answer one of the two probe conventions below, then
// Register it where core is wired (internal/app) with HTTPProbe or NATSProbe.
//
//   - HTTP: GET <base>/version → {"version": "<version>"}
//   - NATS: a request on "eerp.version.<name>" → the version as the reply body
package version

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/nats-io/nats.go"
)

// Version is core's own build version. CI stamps it through the image build
// (-ldflags "-X core/internal/version.Version=0.101.0", core/Dockerfile);
// anything built outside CI reports "dev".
var Version = "dev"

// SubjectPrefix + a service name is the NATS subject a service answers its
// version on.
const SubjectPrefix = "eerp.version."

// probeTimeout bounds one service's answer, so a service that is down only
// shows as unavailable instead of holding the Settings page.
const probeTimeout = 2 * time.Second

// Probe asks one service for its version.
type Probe func(ctx context.Context) (string, error)

// Service is one deployed component shown in the versions list.
type Service struct {
	// Name is the service's stable id (also its NATS subject suffix).
	Name string
	// Label is what Settings shows (an English msgid, translated by the frontend).
	Label string
	Probe Probe
}

// Entry is one row of GET /api/v1/versions. Version is nil when the service
// didn't answer.
type Entry struct {
	Name    string  `json:"name"`
	Label   string  `json:"label"`
	Version *string `json:"version"`
}

// Registry is the ordered list of services core reports. Core itself is always
// first.
type Registry struct {
	mu       sync.Mutex
	services []Service
}

// NewRegistry starts the list with core itself.
func NewRegistry() *Registry {
	return &Registry{services: []Service{{
		Name:  "core",
		Label: "Core",
		Probe: func(context.Context) (string, error) { return Version, nil },
	}}}
}

// Register adds a service, keeping registration order.
func (r *Registry) Register(s Service) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.services = append(r.services, s)
}

// Collect asks every service at once, each bounded by probeTimeout.
func (r *Registry) Collect(ctx context.Context) []Entry {
	r.mu.Lock()
	services := append([]Service(nil), r.services...)
	r.mu.Unlock()

	entries := make([]Entry, len(services))
	var wg sync.WaitGroup
	for i, s := range services {
		entries[i] = Entry{Name: s.Name, Label: s.Label}
		wg.Add(1)
		go func(i int, probe Probe) {
			defer wg.Done()
			pctx, cancel := context.WithTimeout(ctx, probeTimeout)
			defer cancel()
			if v, err := probe(pctx); err == nil && v != "" {
				entries[i].Version = &v
			}
		}(i, s.Probe)
	}
	wg.Wait()
	return entries
}

// HTTPProbe reads {"version": …} from GET <baseURL>/version.
func HTTPProbe(client *http.Client, baseURL string) Probe {
	url := strings.TrimRight(baseURL, "/") + "/version"
	return func(ctx context.Context) (string, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return "", err
		}
		resp, err := client.Do(req)
		if err != nil {
			return "", err
		}
		defer func() { _ = resp.Body.Close() }()
		if resp.StatusCode != http.StatusOK {
			return "", fmt.Errorf("version: %s answered %s", url, resp.Status)
		}
		var body struct {
			Version string `json:"version"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
			return "", err
		}
		return body.Version, nil
	}
}

// NATSProbe requests the version on SubjectPrefix+name. With several replicas
// the first reply wins — replicas of one service run the same image.
func NATSProbe(nc *nats.Conn, name string) Probe {
	return func(ctx context.Context) (string, error) {
		if nc == nil {
			return "", errors.New("version: no NATS connection")
		}
		msg, err := nc.RequestWithContext(ctx, SubjectPrefix+name, nil)
		if err != nil {
			return "", err
		}
		return string(msg.Data), nil
	}
}
