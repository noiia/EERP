package mcpoauth

import (
	"context"
	"net/http"
)

// MetadataMaxBytes is the CIMD size cap, for the oversized-document test.
const MetadataMaxBytes = metadataMaxBytes

var HashToken = hashToken

// UseMetadataClient swaps the CIMD fetcher's HTTP client: the tests' TLS server
// is on loopback, which the production client refuses.
func (h *Handler) UseMetadataClient(c *http.Client) { h.clients = newResolver(h.s, h.store, c) }

// ResolveClient resolves a client_id like the authorize endpoint does.
func (h *Handler) ResolveClient(ctx context.Context, clientID string) (ClientInfo, error) {
	return h.clients.resolve(ctx, clientID)
}

// ResolveWithProductionClient resolves through the real (public addresses only) client.
func (h *Handler) ResolveWithProductionClient(ctx context.Context, clientID string) (ClientInfo, error) {
	return newResolver(h.s, h.store, publicHTTPClient()).resolve(ctx, clientID)
}
