package mail

import (
	"context"
	"errors"
	"testing"

	"core/internal/testdb"
	"core/orm"

	"github.com/google/uuid"
)

func setup(t *testing.T) (*orm.App, uuid.UUID) {
	t.Helper()
	app := testdb.Open(t)
	testdb.MigrateModules(t, app, "mail")
	tenant := uuid.New()
	t.Cleanup(func() {
		_, _ = app.DB.Exec(context.Background(), `DELETE FROM mail_outbox WHERE tenant_id = $1`, tenant)
	})
	return app, tenant
}

func countPending(t *testing.T, app *orm.App, tenant uuid.UUID) int {
	t.Helper()
	var n int
	if err := app.DB.QueryRow(context.Background(),
		`SELECT count(*) FROM mail_outbox WHERE tenant_id = $1 AND status = 'pending'`, tenant).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestEnqueue(t *testing.T) {
	app, tenant := setup(t)
	ctx := context.Background()
	ok := Message{TenantID: tenant, To: "a@b.io", Subject: "Hello", Text: "hi"}

	t.Run("commits with the caller's transaction", func(t *testing.T) {
		if err := orm.Transact(ctx, app.DB, func(tx *orm.Tx) error { return Enqueue(ctx, tx, ok) }); err != nil {
			t.Fatal(err)
		}
		if n := countPending(t, app, tenant); n != 1 {
			t.Fatalf("pending = %d, want 1", n)
		}
	})

	t.Run("rolls back with the caller's transaction", func(t *testing.T) {
		boom := errors.New("business write failed")
		_ = orm.Transact(ctx, app.DB, func(tx *orm.Tx) error {
			if err := Enqueue(ctx, tx, ok); err != nil {
				return err
			}
			return boom
		})
		if n := countPending(t, app, tenant); n != 1 {
			t.Fatalf("pending = %d, want still 1", n)
		}
	})

	invalid := []struct {
		name string
		m    Message
	}{
		{"no tenant", Message{To: "a@b.io", Subject: "s", Text: "t"}},
		{"bad address", Message{TenantID: tenant, To: "nope", Subject: "s", Text: "t"}},
		{"CRLF in subject", Message{TenantID: tenant, To: "a@b.io", Subject: "s\r\nBcc: x@y.io", Text: "t"}},
		{"CRLF in recipient", Message{TenantID: tenant, To: "a@b.io\r\nBcc: x@y.io", Subject: "s", Text: "t"}},
		{"no body", Message{TenantID: tenant, To: "a@b.io", Subject: "s"}},
	}
	for _, tt := range invalid {
		t.Run(tt.name, func(t *testing.T) {
			if err := Enqueue(ctx, app.DB, tt.m); !errors.Is(err, ErrInvalidMessage) {
				t.Errorf("err = %v, want ErrInvalidMessage", err)
			}
		})
	}
}
