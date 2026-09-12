package reports

import (
	"context"
	"testing"
	"time"

	"github.com/nats-io/nats-server/v2/test"
	"github.com/nats-io/nats.go"
)

// startEmbeddedNATS runs an in-process NATS server on a random port — no
// Docker/external infra needed for these tests, mirroring how
// tools/pdf-service tests its own side of this same wire contract.
func startEmbeddedNATS(t *testing.T) string {
	t.Helper()
	srv := test.RunRandClientPortServer()
	t.Cleanup(srv.Shutdown)
	return srv.ClientURL()
}

func connect(t *testing.T, url string) *nats.Conn {
	t.Helper()
	nc, err := nats.Connect(url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(nc.Close)
	return nc
}

// fakeWorker stands in for tools/pdf-service's NATS worker — a bare
// QueueSubscribe replying either the given PDF bytes or an error header,
// enough to prove natsPDFRenderer's own request/reply handling without
// needing that module's actual source (a separate Go module).
func fakeWorker(t *testing.T, nc *nats.Conn, pdf []byte, workerErr string) {
	t.Helper()
	sub, err := nc.Subscribe(renderSubject, func(msg *nats.Msg) {
		if workerErr != "" {
			reply := nats.NewMsg(msg.Reply)
			reply.Header.Set(errorHeader, workerErr)
			_ = msg.RespondMsg(reply)
			return
		}
		_ = msg.Respond(pdf)
	})
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	t.Cleanup(func() { _ = sub.Unsubscribe() })
}

func TestNATSPDFRenderer_ReturnsTheWorkersPDFBytes(t *testing.T) {
	url := startEmbeddedNATS(t)
	fakeWorker(t, connect(t, url), []byte("%PDF-1.4 fake"), "")

	r := NewNATSPDFRenderer(connect(t, url), 5*time.Second)
	pdf, err := r.Render(context.Background(), "http://core-front:3000/print/report/x/1")
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	if string(pdf) != "%PDF-1.4 fake" {
		t.Errorf("pdf = %q, want the worker's bytes", pdf)
	}
}

func TestNATSPDFRenderer_SurfacesTheWorkersErrorHeader(t *testing.T) {
	url := startEmbeddedNATS(t)
	fakeWorker(t, connect(t, url), nil, "render failed")

	r := NewNATSPDFRenderer(connect(t, url), 5*time.Second)
	_, err := r.Render(context.Background(), "http://x")
	if err == nil {
		t.Fatal("expected an error when the worker replies with an error header, got nil")
	}
}

func TestNATSPDFRenderer_TimesOutWhenNoWorkerIsSubscribed(t *testing.T) {
	url := startEmbeddedNATS(t)
	// No fakeWorker — nothing is subscribed to renderSubject.

	r := NewNATSPDFRenderer(connect(t, url), 200*time.Millisecond)
	_, err := r.Render(context.Background(), "http://x")
	if err == nil {
		t.Fatal("expected an error when no worker is available to reply, got nil")
	}
}
