package mail

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/google/uuid"
)

type fakeTransport struct {
	mu    sync.Mutex
	sent  []string
	fail  bool
	calls atomic.Int32
}

func (f *fakeTransport) Send(_ context.Context, o Outbox) error {
	f.calls.Add(1)
	if f.fail {
		return errors.New("relay down")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = append(f.sent, o.ToAddress)
	return nil
}

func rowState(t *testing.T, s *Sender, id uuid.UUID) (status string, attempts int, lastErr string) {
	t.Helper()
	if err := s.db.QueryRow(context.Background(),
		`SELECT status, attempts, last_error FROM mail_outbox WHERE id = $1`, id).Scan(&status, &attempts, &lastErr); err != nil {
		t.Fatal(err)
	}
	return
}

func onlyRow(t *testing.T, s *Sender, tenant uuid.UUID) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := s.db.QueryRow(context.Background(), `SELECT id FROM mail_outbox WHERE tenant_id = $1`, tenant).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func TestSender_SendsDueRows(t *testing.T) {
	app, tenant := setup(t)
	ctx := context.Background()
	for _, to := range []string{"a@x.io", "b@x.io"} {
		if err := Enqueue(ctx, app.DB, Message{TenantID: tenant, To: to, Subject: "s", Text: "t"}); err != nil {
			t.Fatal(err)
		}
	}
	tr := &fakeTransport{}
	s := NewSender(app.DB, tr)
	if sent, failed, err := s.Tick(ctx, tenant); err != nil || sent != 2 || failed != 0 {
		t.Fatalf("tick = %d sent, %d failed, %v", sent, failed, err)
	}
	if n := countPending(t, app, tenant); n != 0 {
		t.Errorf("pending = %d, want 0", n)
	}
	// A second tick finds nothing due.
	if sent, _, _ := s.Tick(ctx, tenant); sent != 0 {
		t.Errorf("second tick sent %d, want 0", sent)
	}
}

func TestSender_BacksOffThenFails(t *testing.T) {
	app, tenant := setup(t)
	ctx := context.Background()
	if err := Enqueue(ctx, app.DB, Message{TenantID: tenant, To: "a@x.io", Subject: "s", Text: "t"}); err != nil {
		t.Fatal(err)
	}
	s := NewSender(app.DB, &fakeTransport{fail: true})
	id := onlyRow(t, s, tenant)

	for attempt := 1; attempt <= maxAttempts; attempt++ {
		// Make the row due again without waiting out the backoff.
		if _, err := app.DB.Exec(ctx, `UPDATE mail_outbox SET next_attempt_at = now() WHERE id = $1`, id); err != nil {
			t.Fatal(err)
		}
		if _, failed, err := s.Tick(ctx, tenant); err != nil || failed != 1 {
			t.Fatalf("attempt %d: failed=%d err=%v", attempt, failed, err)
		}
		status, attempts, lastErr := rowState(t, s, id)
		wantStatus := StatusPending
		if attempt == maxAttempts {
			wantStatus = StatusFailed
		}
		if status != wantStatus || attempts != attempt || lastErr != "relay down" {
			t.Fatalf("attempt %d: status=%s attempts=%d lastErr=%q", attempt, status, attempts, lastErr)
		}
	}

	t.Run("backoff pushes next_attempt_at into the future", func(t *testing.T) {
		var future bool
		_ = app.DB.QueryRow(ctx, `SELECT next_attempt_at > now() FROM mail_outbox WHERE id = $1`, id).Scan(&future)
		if !future {
			t.Error("next_attempt_at not pushed forward")
		}
	})
}

// Review Focus #3: two concurrent ticks never send one row twice.
func TestSender_ConcurrentTicksSendOnce(t *testing.T) {
	app, tenant := setup(t)
	ctx := context.Background()
	for i := 0; i < 10; i++ {
		if err := Enqueue(ctx, app.DB, Message{TenantID: tenant, To: "a@x.io", Subject: "s", Text: "t"}); err != nil {
			t.Fatal(err)
		}
	}
	tr := &fakeTransport{}
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _, _ = NewSender(app.DB, tr).Tick(ctx, tenant)
		}()
	}
	wg.Wait()
	if got := tr.calls.Load(); got != 10 {
		t.Errorf("transport called %d times, want exactly 10", got)
	}
}
