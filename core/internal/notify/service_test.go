package notify_test

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"core/internal/notify"

	"github.com/google/uuid"
)

type sent struct {
	tenant uuid.UUID
	users  []uuid.UUID
	frame  map[string]any
}

type fakePub struct {
	mu   sync.Mutex
	sent []sent
}

func (p *fakePub) SendToUsers(tenant uuid.UUID, users []uuid.UUID, payload []byte) {
	var frame map[string]any
	_ = json.Unmarshal(payload, &frame)
	p.mu.Lock()
	p.sent = append(p.sent, sent{tenant, users, frame})
	p.mu.Unlock()
}

func (p *fakePub) all() []sent {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]sent(nil), p.sent...)
}

func TestValidLink(t *testing.T) {
	tests := []struct {
		link string
		ok   bool
	}{
		{"/settings/developer", true},
		{"/cron/123", true},
		{"", false},
		{"//evil.example", false},
		{"https://evil.example", false},
		{"javascript:alert(1)", false},
		{"/\\evil.example", false},
	}
	for _, tc := range tests {
		t.Run(tc.link, func(t *testing.T) {
			if got := notify.ValidLink(tc.link); got != tc.ok {
				t.Errorf("ValidLink(%q) = %v, want %v", tc.link, got, tc.ok)
			}
		})
	}
}

func TestService_PersonalGoesToOwnerOnly(t *testing.T) {
	f := setup(t)
	pub := &fakePub{}
	svc := notify.NewService(f.repo, pub)
	n, err := svc.Personal(context.Background(), f.tenant, f.bob, notify.Message{Category: "dev_seed", Title: "Done", Link: "/settings/developer"})
	if err != nil {
		t.Fatal(err)
	}
	got := pub.all()
	if len(got) != 1 || len(got[0].users) != 1 || got[0].users[0] != f.bob || got[0].tenant != f.tenant {
		t.Fatalf("sent = %+v, want one frame to bob", got)
	}
	if got[0].frame["type"] != "notification" {
		t.Errorf("frame type = %v", got[0].frame["type"])
	}
	if inner, _ := got[0].frame["notification"].(map[string]any); inner["id"] != n.ID.String() {
		t.Errorf("frame notification = %v", got[0].frame["notification"])
	}
}

func TestService_RejectsBadInput(t *testing.T) {
	f := setup(t)
	svc := notify.NewService(f.repo, &fakePub{})
	ctx := context.Background()
	if _, err := svc.Personal(ctx, f.tenant, f.bob, notify.Message{Category: "nope", Title: "x", Link: "/x"}); err == nil {
		t.Error("an unregistered category must be refused")
	}
	if _, err := svc.Start(ctx, f.tenant, notify.Activity{Category: "cron", Title: "x", Link: "//evil"}); err == nil {
		t.Error("an external link must be refused")
	}
}

func TestService_ActivityLifecycle(t *testing.T) {
	f := setup(t)
	pub := &fakePub{}
	svc := notify.NewService(f.repo, pub)
	ctx := context.Background()

	run, err := svc.Start(ctx, f.tenant, notify.Activity{Category: "cron", Title: "Nightly", Link: "/cron/1"})
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 50; i++ { // a tight loop must be throttled
		run.Progress(i, "step")
	}
	run.Finish(errors.New("boom"), "", nil)

	frames := pub.all()
	if len(frames) < 2 || len(frames) > 4 {
		t.Fatalf("frames = %d, want start + throttled progress + finish", len(frames))
	}
	for _, s := range frames {
		if len(s.users) != 1 || s.users[0] != f.alice {
			t.Errorf("cron activity sent to %v, want [alice] (bob has no cron category)", s.users)
		}
	}
	last, _ := frames[len(frames)-1].frame["notification"].(map[string]any)
	if last["status"] != "failed" || last["body"] != "boom" {
		t.Errorf("final frame = %v, want failed/boom", last)
	}
	time.Sleep(10 * time.Millisecond)
}
