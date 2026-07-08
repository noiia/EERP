package pictures

import (
	"bytes"
	"context"
	"io"
	"net"
	"net/url"
	"strings"
	"testing"
	"time"

	"core/internal/common"
	"core/internal/types"

	"github.com/google/uuid"
)

// devStore builds the S3 store from the committed dev config (the same s3_*
// fields the app reads) and skips the test when the Garage node is not
// reachable — the same stance the frontend takes with TEST_API_BASE: the
// round-trip proves the real storage path when the dev stack is up, and stays
// silent on machines without it.
func devStore(t *testing.T) ObjectStore {
	t.Helper()

	cfg, err := common.DecodeJSON[*types.Config]("../../../eerp-config.json")
	if err != nil {
		t.Skipf("dev config unreadable: %v", err)
	}
	if !S3Configured(cfg) {
		t.Skip("s3_* not configured in the dev config")
	}

	endpoint, err := url.Parse(cfg.S3Endpoint)
	if err != nil {
		t.Fatalf("parse s3_endpoint: %v", err)
	}
	conn, err := net.DialTimeout("tcp", endpoint.Host, time.Second)
	if err != nil {
		t.Skipf("garage unreachable at %s — start it with `docker compose up garage` + `make garage-init`", endpoint.Host)
	}
	_ = conn.Close()

	store, err := NewS3Store(cfg)
	if err != nil {
		t.Fatalf("build s3 store: %v", err)
	}
	return store
}

func TestS3StoreRoundTrip(t *testing.T) {
	store := devStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	key := "test/" + uuid.NewString()
	payload := []byte("round-trip-bytes")

	if err := store.Put(ctx, key, "image/png", int64(len(payload)), bytes.NewReader(payload)); err != nil {
		t.Fatalf("put: %v", err)
	}
	// Whatever happens below, don't leave test objects in the dev bucket.
	defer func() { _ = store.Delete(ctx, key) }()

	body, contentType, err := store.Get(ctx, key)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	got, err := io.ReadAll(body)
	_ = body.Close()
	if err != nil {
		t.Fatalf("read object: %v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Errorf("object bytes = %q, want %q", got, payload)
	}
	if contentType != "image/png" {
		t.Errorf("content type = %s, want image/png", contentType)
	}

	if err := store.Delete(ctx, key); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, _, err := store.Get(ctx, key); err == nil {
		t.Error("get after delete succeeded — object not removed")
	} else if !strings.Contains(err.Error(), key) {
		t.Errorf("error %q does not name the missing key", err)
	}
}
