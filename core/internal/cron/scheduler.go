package cron

import (
	"context"
	"fmt"
	"time"

	"core/internal/auth"
	"core/internal/chatter"
	"core/internal/common"
	"core/orm"

	"github.com/google/uuid"
	"go.uber.org/zap"
)

// pollInterval is how often the scheduler checks for due crons — a minute,
// cron's traditional granularity (docs/adr/ADR-016-cron-scheduler.md); a
// one-shot ExecutionDate a minute early or late is not meaningfully
// different from crontab's own minute resolution.
const pollInterval = time.Minute

// Scheduler polls for due Cron rows, runs each one's registered Action as
// its configured RunAsUserID (permission-checked first), and records one
// CronHistory row + log file per attempt. One Scheduler runs process-wide,
// across every tenant — unlike an HTTP request, a background loop has no
// caller identity to scope a query to, so it queries every tenant's due
// rows in one pass and carries each row's own TenantID through to its
// history/log/chatter writes.
type Scheduler struct {
	db        *orm.DB
	crons     *orm.Repository[Cron]
	histories *orm.Repository[CronHistory]
	users     *auth.UserRepository
	perms     *auth.PermissionRepository
	chatter   *chatter.Repository
	logDir    string
}

// NewScheduler builds a Scheduler bound to db. logDir is Config.CronLogDir,
// already resolved to an absolute path by main.go.
func NewScheduler(db *orm.DB, users *auth.UserRepository, perms *auth.PermissionRepository, chatterRepo *chatter.Repository, logDir string) *Scheduler {
	return &Scheduler{
		db:        db,
		crons:     orm.MustRepo[Cron](db),
		histories: orm.MustRepo[CronHistory](db),
		users:     users,
		perms:     perms,
		chatter:   chatterRepo,
		logDir:    logDir,
	}
}

// Run polls until ctx is canceled — call it in its own goroutine at
// startup (main.go). Each tick both runs due crons and sweeps expired
// history; the sweep is cheap (a handful of indexed rows in the expected
// deployment size) and idempotent, so piggybacking it on the same tick
// avoids a second ticker/goroutine for what is otherwise "one more thing to
// check every so often" (ponytail: a dedicated daily timer would be more
// precise about WHEN retention runs, but nothing here depends on that
// precision — add one if the sweep ever needs to avoid a specific busy
// window).
func (s *Scheduler) Run(ctx context.Context) {
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.tick(ctx)
		}
	}
}

func (s *Scheduler) tick(ctx context.Context) {
	due, err := s.dueCrons(ctx)
	if err != nil {
		common.Logger.Error("cron: scheduler: list due crons", zap.Error(err))
		return
	}
	for _, c := range due {
		s.runOne(ctx, c)
	}
	if err := SweepHistory(ctx, s.db, s.logDir); err != nil {
		common.Logger.Error("cron: scheduler: retention sweep", zap.Error(err))
	}
}

// dueCrons returns every active cron whose ExecutionDate is set and in the
// past — across every tenant (see Scheduler's doc comment).
func (s *Scheduler) dueCrons(ctx context.Context) ([]Cron, error) {
	// Each Cond's placeholder starts at $1, independent of the others — the
	// query builder rebases them to the query's real argument positions
	// (core/orm/query/condition.go's Condition.rebase).
	rows, err := s.crons.FindAll(ctx,
		orm.Cond("status = $1", "active"),
		orm.Cond("execution_date IS NOT NULL"),
		orm.Cond("execution_date <= $1", time.Now()))
	if err != nil {
		return nil, fmt.Errorf("cron: due crons: %w", err)
	}
	return rows, nil
}

// runOne executes a single due cron: resolve its action, permission-check
// its run-as user, run it, and record exactly one CronHistory row + log
// file no matter which step failed. ExecutionDate is always cleared
// afterward (see Cron.ExecutionDate's doc comment) — a cron that failed to
// run still "ran" in the sense that matters here: it won't silently re-fire
// every minute until someone notices.
func (s *Scheduler) runOne(ctx context.Context, c Cron) {
	start := time.Now()
	var logLines []string
	logf := func(format string, args ...any) {
		logLines = append(logLines, fmt.Sprintf("[%s] ", time.Now().Format(time.RFC3339))+fmt.Sprintf(format, args...))
	}

	failed := s.attempt(ctx, c, logf)

	// runID only names the log file uniquely — it is NOT the CronHistory
	// row's own PK (that's DB-generated on Create below, same as every
	// other entity in this codebase). The row's LogsFilepath column is what
	// actually links the two; nothing depends on the id and the filename
	// matching.
	runID := uuid.New()
	logPath := LogPath(s.logDir, c.TenantID, c.ID, runID)
	content := fmt.Sprintf("cron: %s (%s)\naction: %s\nstarted: %s\n\n", c.Name, c.ID, c.ActionID, start.Format(time.RFC3339))
	for _, line := range logLines {
		content += line + "\n"
	}
	if err := WriteLog(logPath, content); err != nil {
		common.Logger.Error("cron: could not write run log", zap.String("cron_id", c.ID.String()), zap.Error(err))
	}

	history := CronHistory{TenantID: c.TenantID, CronID: c.ID, Failed: failed, LogsFilepath: logPath}
	if _, err := s.histories.Create(ctx, history); err != nil {
		common.Logger.Error("cron: could not record run history", zap.String("cron_id", c.ID.String()), zap.Error(err))
	}

	c.ExecutionDate = nil
	if _, err := s.crons.Update(ctx, c, c.ID); err != nil {
		common.Logger.Error("cron: could not clear execution_date after run", zap.String("cron_id", c.ID.String()), zap.Error(err))
	}
}

// attempt runs the cron's action end to end, writing each step's outcome
// through logf, and reports whether the run failed. Split out from runOne
// so every failure path (unknown action, no run-as user, missing
// permission, the action's own error) funnels through ONE place that both
// logs and — for the permission case specifically — tells the user which
// action they lack rights for (the request's own wording), via a chatter
// "log" entry on the cron record: the scheduler has no live HTTP caller to
// return an error to, so the record's own activity feed (already the
// engine's channel for "system told me something about this record," see
// core-front/CLAUDE.md's Form chatter panel row) is the natural place a
// user actually looking at this cron will see it.
func (s *Scheduler) attempt(ctx context.Context, c Cron, logf func(string, ...any)) (failed bool) {
	action, ok := Get(c.ActionID)
	if !ok {
		logf("ERROR: unknown action_id %q", c.ActionID)
		return true
	}
	if c.RunAsUserID == nil {
		logf("ERROR: no run_as_user configured")
		return true
	}

	user, err := s.users.FindByID(ctx, *c.RunAsUserID)
	if err != nil {
		logf("ERROR: run_as_user %s not found: %v", *c.RunAsUserID, err)
		return true
	}

	if action.RequiredPermission != "" {
		roles, err := s.users.FindRoleNames(ctx, user.ID)
		if err != nil {
			logf("ERROR: could not resolve roles for %s: %v", user.Email, err)
			return true
		}
		ok, err := s.perms.Has(ctx, roles, action.RequiredPermission)
		if err != nil {
			logf("ERROR: permission check failed: %v", err)
			return true
		}
		if !ok {
			msg := fmt.Sprintf("%s does not have the rights to run action %q (%s) — missing permission %q",
				user.Email, action.Label, action.ID, action.RequiredPermission)
			logf("ERROR: %s", msg)
			s.postChatterError(ctx, c, msg)
			return true
		}
	}

	logf("running action %q as %s", action.ID, user.Email)
	if err := action.Run(ctx); err != nil {
		logf("ERROR: %v", err)
		return true
	}
	logf("ok")
	return false
}

// postChatterError posts a "system told the user about this cron" entry on
// the cron's own activity feed. Best-effort: a chatter write failing must
// never mask the run's own recorded outcome (the CronHistory row/log
// already carry it regardless).
func (s *Scheduler) postChatterError(ctx context.Context, c Cron, message string) {
	if s.chatter == nil || c.RunAsUserID == nil {
		return
	}
	user, err := s.users.FindByID(ctx, *c.RunAsUserID)
	if err != nil {
		return
	}
	_, err = s.chatter.Create(ctx, chatter.ChatterMessage{
		TenantID: c.TenantID, TableName: "cron", RecordID: c.ID,
		AuthorID: user.ID, AuthorEmail: user.Email,
		Kind: "log", Body: message,
	})
	if err != nil {
		common.Logger.Warn("cron: could not post permission-error chatter message", zap.Error(err))
	}
}
