package sale

import (
	"context"
	"testing"
	"time"

	"core/internal/testdb"
	"core/orm"
	"core/orm/model"

	"github.com/google/uuid"
)

func TestExpireOverdueQuotes(t *testing.T) {
	app := testdb.Open(t)
	if err := (&saleModule{}).Register(); err != nil {
		t.Fatalf("register: %v", err)
	}
	testdb.Migrate(t, app, "quote")

	ctx := context.Background()
	quotes := orm.MustRepo[Quote](app.DB)
	tenant := uuid.New()
	past := time.Now().Add(-24 * time.Hour)
	future := time.Now().Add(24 * time.Hour)

	tests := []struct {
		name        string
		status      string
		due         *time.Time
		softDeleted bool
		want        string
	}{
		{"no due date never expires", "draft", nil, false, "draft"},
		{"draft past due date expires", "draft", &past, false, "expired"},
		{"confirmed past due date expires", "confirmed", &past, false, "expired"},
		{"sent past due date expires", "sent", &past, false, "expired"},
		{"draft not yet due does not expire", "draft", &future, false, "draft"},
		{"accepted stays accepted (terminal)", "accepted", &past, false, "accepted"},
		{"declined stays declined (terminal)", "declined", &past, false, "declined"},
		{"expired stays expired", "expired", &past, false, "expired"},
		{"soft-deleted quote is not touched", "draft", &past, true, "draft"},
	}
	ids := make([]uuid.UUID, len(tests))
	for i, tt := range tests {
		q, err := quotes.Create(ctx, Quote{BaseModel: model.BaseModel{TenantID: tenant}, Status: tt.status, DueDate: tt.due})
		if err != nil {
			t.Fatalf("seed %q: %v", tt.name, err)
		}
		t.Cleanup(func() { _, _ = quotes.HardDelete(ctx, q.ID) })
		if tt.softDeleted {
			if _, err := quotes.Delete(ctx, q.ID); err != nil {
				t.Fatalf("soft delete: %v", err)
			}
		}
		ids[i] = q.ID
	}

	if err := ExpireOverdueQuotes(ctx, app.DB); err != nil {
		t.Fatalf("ExpireOverdueQuotes: %v", err)
	}

	for i, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var got string
			if err := app.DB.QueryRow(ctx, `SELECT status FROM quote WHERE id = $1`, ids[i]).Scan(&got); err != nil {
				t.Fatalf("read back: %v", err)
			}
			if got != tt.want {
				t.Errorf("status = %q, want %q", got, tt.want)
			}
		})
	}
}
