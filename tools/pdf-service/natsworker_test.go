package main

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/nats-io/nats-server/v2/test"
	"github.com/nats-io/nats.go"

	"pdf-service/renderer"
)

// stubRenderer avoids needing a real Chrome binary for these tests — the
// real renderer.ChromeRenderer is covered against a real browser in
// renderer/renderer_test.go; this package only needs to prove the NATS
// transport wiring.
type stubRenderer struct {
	pdf []byte
	err error
}

func (s *stubRenderer) Render(_ context.Context, _ renderer.RenderRequest) ([]byte, error) {
	if s.err != nil {
		return nil, s.err
	}
	return s.pdf, nil
}

// startEmbeddedNATS runs an in-process NATS server on a random port — no
// Docker/external infra needed for these tests (github.com/nats-io/
// nats-server/v2/test, the same package the nats.go project's own tests use).
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

func TestNATSWorker_RendersAndRepliesWithThePDFBytes(t *testing.T) {
	url := startEmbeddedNATS(t)
	workerConn := connect(t, url)
	r := &stubRenderer{pdf: []byte("%PDF-1.4 fake")}
	sub, err := runNATSWorker(workerConn, r)
	if err != nil {
		t.Fatalf("runNATSWorker: %v", err)
	}
	defer func() { _ = sub.Unsubscribe() }()

	client := connect(t, url)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	reply, err := client.RequestWithContext(ctx, renderSubject, []byte(`{"url":"http://x","wait_for":"[data-report-ready]"}`))
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	if string(reply.Data) != "%PDF-1.4 fake" {
		t.Errorf("reply body = %q, want the rendered PDF bytes", reply.Data)
	}
	if reply.Header.Get(errorHeader) != "" {
		t.Errorf("unexpected error header on a successful render: %q", reply.Header.Get(errorHeader))
	}
}

func TestNATSWorker_RespondsWithAnErrorHeaderOnRenderFailure(t *testing.T) {
	url := startEmbeddedNATS(t)
	workerConn := connect(t, url)
	r := &stubRenderer{err: errors.New("chrome exploded")}
	sub, err := runNATSWorker(workerConn, r)
	if err != nil {
		t.Fatalf("runNATSWorker: %v", err)
	}
	defer func() { _ = sub.Unsubscribe() }()

	client := connect(t, url)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	reply, err := client.RequestWithContext(ctx, renderSubject, []byte(`{"url":"http://x"}`))
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	if reply.Header.Get(errorHeader) == "" {
		t.Error("expected an error header on a failed render, got none")
	}
}

func TestNATSWorker_RejectsAMissingURL(t *testing.T) {
	url := startEmbeddedNATS(t)
	workerConn := connect(t, url)
	sub, err := runNATSWorker(workerConn, &stubRenderer{pdf: []byte("should not be reached")})
	if err != nil {
		t.Fatalf("runNATSWorker: %v", err)
	}
	defer func() { _ = sub.Unsubscribe() }()

	client := connect(t, url)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	reply, err := client.RequestWithContext(ctx, renderSubject, []byte(`{"url":""}`))
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	if reply.Header.Get(errorHeader) == "" {
		t.Error("expected an error header for a missing url, got none")
	}
}

// TestNATSWorker_QueueGroupLoadBalances proves the actual Phase 5 promise:
// two replicas subscribed to the SAME queue group split the work — each
// request is handled by exactly one worker (never both, never zero), which
// is what lets N replicas scale throughput linearly (docs/adr/ADR-010).
func TestNATSWorker_QueueGroupLoadBalances(t *testing.T) {
	url := startEmbeddedNATS(t)

	var worker1Count, worker2Count int
	r1 := &countingRenderer{count: &worker1Count}
	r2 := &countingRenderer{count: &worker2Count}

	conn1 := connect(t, url)
	sub1, err := runNATSWorker(conn1, r1)
	if err != nil {
		t.Fatalf("runNATSWorker (1): %v", err)
	}
	defer func() { _ = sub1.Unsubscribe() }()

	conn2 := connect(t, url)
	sub2, err := runNATSWorker(conn2, r2)
	if err != nil {
		t.Fatalf("runNATSWorker (2): %v", err)
	}
	defer func() { _ = sub2.Unsubscribe() }()

	client := connect(t, url)
	const requests = 20
	for i := 0; i < requests; i++ {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		reply, err := client.RequestWithContext(ctx, renderSubject, []byte(`{"url":"http://x"}`))
		cancel()
		if err != nil {
			t.Fatalf("request %d: %v", i, err)
		}
		if reply.Header.Get(errorHeader) != "" {
			t.Fatalf("request %d: unexpected error header %q", i, reply.Header.Get(errorHeader))
		}
	}

	if worker1Count+worker2Count != requests {
		t.Fatalf("total handled = %d, want exactly %d (no duplication, no drops)", worker1Count+worker2Count, requests)
	}
	if worker1Count == 0 || worker2Count == 0 {
		t.Errorf("expected BOTH workers to receive at least one request (load balanced), got worker1=%d worker2=%d",
			worker1Count, worker2Count)
	}
}

// TestNATSWorker_SurvivesAWorkerCrash proves the crash-safety half of Phase
// 5's DoD: killing one replica mid-deployment doesn't take down the queue —
// the survivor keeps serving every subsequent request.
func TestNATSWorker_SurvivesAWorkerCrash(t *testing.T) {
	url := startEmbeddedNATS(t)

	conn1 := connect(t, url)
	sub1, err := runNATSWorker(conn1, &stubRenderer{pdf: []byte("from worker 1")})
	if err != nil {
		t.Fatalf("runNATSWorker (1): %v", err)
	}

	conn2 := connect(t, url)
	sub2, err := runNATSWorker(conn2, &stubRenderer{pdf: []byte("from worker 2")})
	if err != nil {
		t.Fatalf("runNATSWorker (2): %v", err)
	}
	defer func() { _ = sub2.Unsubscribe() }()

	// Simulate worker 1 crashing: unsubscribe and close its connection.
	_ = sub1.Unsubscribe()
	conn1.Close()

	client := connect(t, url)
	for i := 0; i < 5; i++ {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		reply, err := client.RequestWithContext(ctx, renderSubject, []byte(`{"url":"http://x"}`))
		cancel()
		if err != nil {
			t.Fatalf("request %d after worker crash: %v", i, err)
		}
		if string(reply.Data) != "from worker 2" {
			t.Errorf("request %d: reply = %q, want the survivor's response", i, reply.Data)
		}
	}
}

type countingRenderer struct {
	count *int
	pdf   []byte
}

func (c *countingRenderer) Render(_ context.Context, _ renderer.RenderRequest) ([]byte, error) {
	*c.count++
	if c.pdf != nil {
		return c.pdf, nil
	}
	return []byte("%PDF-ok"), nil
}
