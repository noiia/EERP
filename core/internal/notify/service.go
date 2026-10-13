package notify

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"

	"core/internal/common"
	"core/orm/model"

	"github.com/google/uuid"
	"go.uber.org/zap"
)

// Publisher routes a live frame to the given users' open connections in one
// tenant (presence.Hub implements it).
type Publisher interface {
	SendToUsers(tenantID uuid.UUID, userIDs []uuid.UUID, payload []byte)
}

// progressInterval is the minimum gap between two live progress frames of one activity.
const progressInterval = 500 * time.Millisecond

// Service raises notifications: it validates, stores, then publishes each one
// to exactly the users allowed to see it.
type Service struct {
	repo *Repository
	pub  Publisher
}

// NewService wires the service. pub may be nil (no live delivery).
func NewService(repo *Repository, pub Publisher) *Service { return &Service{repo: repo, pub: pub} }

// Repo exposes the store (handlers, boot hooks).
func (s *Service) Repo() *Repository { return s.repo }

// ValidLink reports whether link is an ERP-relative path ("/x", never
// "//host", a scheme, or a backslash) — a notification can't open another site.
func ValidLink(link string) bool {
	return strings.HasPrefix(link, "/") && !strings.HasPrefix(link, "//") && !strings.ContainsAny(link, "\\:")
}

func validate(category, link string) error {
	if !IsCategory(category) {
		return fmt.Errorf("notify: unregistered category %q", category)
	}
	if !ValidLink(link) {
		return fmt.Errorf("notify: link %q is not an ERP path", link)
	}
	return nil
}

// Message is a one-off personal notification.
type Message struct {
	Category, Title, Body, Link string
	Data                        *string
}

// Personal stores a notification for user only and delivers it live to that
// user's connections.
func (s *Service) Personal(ctx context.Context, tenant, user uuid.UUID, m Message) (Notification, error) {
	if err := validate(m.Category, m.Link); err != nil {
		return Notification{}, err
	}
	n, err := s.repo.Create(ctx, Notification{
		BaseModel: model.BaseModel{TenantID: tenant}, UserID: &user,
		Category: m.Category, Kind: "message", Title: m.Title, Body: m.Body, Link: m.Link, Data: m.Data,
	})
	if err != nil {
		return Notification{}, err
	}
	s.send(n, []uuid.UUID{user})
	return n, nil
}

// Activity describes a global job.
type Activity struct {
	Category, Title, Link string
	ActorID               *uuid.UUID
	// Indeterminate: no percentage (a cron run) — progress stays NULL.
	Indeterminate bool
}

// Start stores a running global activity and announces it to its audience.
func (s *Service) Start(ctx context.Context, tenant uuid.UUID, a Activity) (*Run, error) {
	if err := validate(a.Category, a.Link); err != nil {
		return nil, err
	}
	running := "running"
	var progress *int
	if !a.Indeterminate {
		zero := 0
		progress = &zero
	}
	n, err := s.repo.Create(ctx, Notification{
		BaseModel: model.BaseModel{TenantID: tenant}, Category: a.Category, Kind: "activity",
		Title: a.Title, Link: a.Link, Status: &running, Progress: progress, ActorID: a.ActorID,
	})
	if err != nil {
		return nil, err
	}
	run := &Run{svc: s, n: n}
	s.publishGlobal(n)
	return run, nil
}

// Run is one started activity. Safe for use from one goroutine at a time.
type Run struct {
	svc       *Service
	mu        sync.Mutex
	n         Notification
	lastSent  time.Time
	lastLabel string
}

// ID is the activity's notification id.
func (r *Run) ID() uuid.UUID { return r.n.ID }

// Progress reports pct (0–100) and a step label. Throttled: at most one live
// frame per progressInterval, and a database write only when the label changes.
func (r *Run) Progress(pct int, label string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	pct = max(0, min(100, pct))
	r.n.Progress, r.n.ProgressLabel = &pct, &label
	if label != r.lastLabel {
		r.lastLabel = label
		if n, err := r.svc.repo.UpdateActivity(context.Background(), r.n.ID, ActivityUpdate{Progress: &pct, ProgressLabel: &label}); err == nil {
			r.n = n
		} else {
			common.Logger.Warn("notify: progress write", zap.Error(err))
		}
	}
	if time.Since(r.lastSent) < progressInterval {
		return
	}
	r.lastSent = time.Now()
	r.svc.publishGlobal(r.n)
}

// Finish ends the activity: done, or failed with err's message. body
// overrides the stored body when non-empty; data is stored as is.
func (r *Run) Finish(err error, body string, data *string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	status := "done"
	if err != nil {
		status = "failed"
		if body == "" {
			body = err.Error()
		}
	}
	u := ActivityUpdate{Status: &status, Data: data, Finished: true}
	if body != "" {
		u.Body = &body
	}
	if status == "done" && r.n.Progress != nil {
		full := 100
		u.Progress = &full
	}
	// A few attempts: a lost final write leaves the row "running" until the
	// next restart (and blocks a new seed of the tenant).
	var werr error
	for attempt := 0; attempt < finishAttempts; attempt++ {
		var n Notification
		if n, werr = r.svc.repo.UpdateActivity(context.Background(), r.n.ID, u); werr == nil {
			r.n = n
			break
		}
		time.Sleep(time.Duration(attempt+1) * finishRetryDelay)
	}
	if werr != nil {
		common.Logger.Error("notify: finish write", zap.Error(werr))
		// Still tell the browsers the run ended, from the in-memory state.
		now := time.Now()
		r.n.Status, r.n.FinishedAt = &status, &now
		if u.Body != nil {
			r.n.Body = *u.Body
		}
		if u.Progress != nil {
			r.n.Progress = u.Progress
		}
		if data != nil {
			r.n.Data = data
		}
	}
	r.svc.publishGlobal(r.n)
}

// finishAttempts/finishRetryDelay bound Finish's retries of its final write.
const (
	finishAttempts   = 3
	finishRetryDelay = 100 * time.Millisecond
)

// FailInterrupted marks activities a previous process left running (created
// before startedAt) failed. Call it from a real server start, never from a
// build that may share the database with a running server (tests).
func (s *Service) FailInterrupted(ctx context.Context, startedAt time.Time) error {
	_, err := s.repo.FailInterrupted(ctx, startedAt)
	return err
}

func (s *Service) publishGlobal(n Notification) {
	if s.pub == nil {
		return
	}
	users, err := s.repo.Audience(context.Background(), n.TenantID, n.Category)
	if err != nil {
		common.Logger.Warn("notify: audience", zap.Error(err))
		return
	}
	// The initiator always follows what they started (the feed's visible filter agrees).
	if n.ActorID != nil && !slices.Contains(users, *n.ActorID) {
		users = append(users, *n.ActorID)
	}
	s.send(n, users)
}

func (s *Service) send(n Notification, users []uuid.UUID) {
	if s.pub == nil || len(users) == 0 {
		return
	}
	payload, err := json.Marshal(struct {
		Type         string `json:"type"`
		Notification Wire   `json:"notification"`
	}{"notification", toWire(n)})
	if err != nil {
		common.Logger.Warn("notify: encode frame", zap.Error(err))
		return
	}
	s.pub.SendToUsers(n.TenantID, users, payload)
}

// Wire is the JSON shape of a notification, for live frames and the feed.
// model.BaseModel carries no json tags, and the owner/actor/tenant ids must
// never reach a browser, so it is spelled out here.
type Wire struct {
	ID            uuid.UUID  `json:"id"`
	Category      string     `json:"category"`
	Kind          string     `json:"kind"`
	Title         string     `json:"title"`
	Body          string     `json:"body"`
	Link          string     `json:"link"`
	Status        *string    `json:"status"`
	Progress      *int       `json:"progress"`
	ProgressLabel *string    `json:"progress_label"`
	FinishedAt    *time.Time `json:"finished_at"`
	CreatedAt     time.Time  `json:"created_at"`
	Data          *string    `json:"data"`
}

func toWire(n Notification) Wire {
	return Wire{ID: n.ID, Category: n.Category, Kind: n.Kind, Title: n.Title, Body: n.Body, Link: n.Link,
		Status: n.Status, Progress: n.Progress, ProgressLabel: n.ProgressLabel, FinishedAt: n.FinishedAt,
		CreatedAt: n.CreatedAt, Data: n.Data}
}

// WireItem is a feed row as the browser receives it.
type WireItem struct {
	Wire
	Read bool `json:"read"`
}
