package module

import (
	"context"
	"fmt"
	"time"

	"core/internal/common"
	"core/orm"
	"core/orm/model"

	"github.com/google/uuid"
	"go.uber.org/zap"
)

// ModuleOperationLog is one step of one activate/deactivate/reload run,
// backing the App Store's "Logs" wizard (docs/roadmaps/app-store.md). It sits
// off the generic CRUD surface — workspace-wide like the module.json records
// themselves (manager.go), never tenant-scoped — created via the same
// ensureTable/ensureColumns primitives migration.go already uses for
// module-owned tables, not orm.Register[T] (which would mount generic CRUD
// routes for it).
type ModuleOperationLog struct {
	model.BaseModel
	OperationID uuid.UUID `db:"operation_id,index"`
	ModuleName  string    `db:"module_name,index"`
	Operation   string    `db:"operation"` // activate | deactivate | reload
	Source      string    `db:"source"`    // backend | db
	Level       string    `db:"level"`     // info | warn | error
	Message     string    `db:"message"`
}

var operationLogFields = []orm.MigrationField{
	{Column: "operation_id", SQLType: "UUID", Index: true},
	{Column: "module_name", SQLType: "TEXT", Index: true},
	{Column: "operation", SQLType: "TEXT"},
	{Column: "source", SQLType: "TEXT"},
	{Column: "level", SQLType: "TEXT"},
	{Column: "message", SQLType: "TEXT"},
}

const operationLogTable = "module_operation_log"

// bootstrapOperationLogTable creates module_operation_log if it doesn't
// exist yet — called once from Registry.Boot, mirroring
// bootstrapMigrationsTable's pattern for module_migrations.
func bootstrapOperationLogTable(ctx context.Context, db *orm.DB) error {
	if err := ensureTable(ctx, db, operationLogTable); err != nil {
		return fmt.Errorf("ensure table %s: %w", operationLogTable, err)
	}
	return ensureColumns(ctx, db, operationLogTable, operationLogFields)
}

// OpLogRepository is the store OpLogger writes to and the Logs handler reads
// from.
type OpLogRepository struct {
	logs *orm.Repository[ModuleOperationLog]
}

// NewOpLogRepository wires the repository. Call once at startup, after
// bootstrapOperationLogTable has run.
func NewOpLogRepository(db *orm.DB) *OpLogRepository {
	return &OpLogRepository{logs: orm.MustRepo[ModuleOperationLog](db)}
}

// insert writes one log row, best-effort — see OpLogger.Log.
func (r *OpLogRepository) insert(ctx context.Context, entry ModuleOperationLog) error {
	_, err := r.logs.Create(ctx, entry)
	return err
}

// forModule returns every log row for moduleName, most recent first.
func (r *OpLogRepository) forModule(ctx context.Context, moduleName string, limit int) ([]ModuleOperationLog, error) {
	rows, err := r.logs.FindAll(ctx, orm.Cond("module_name = $1", moduleName))
	if err != nil {
		return nil, fmt.Errorf("module operation log: find: %w", err)
	}
	// FindAll has no ORDER BY on this ad-hoc query shape — sort here. Newest
	// first: both the natural reading order for a log and what groups a
	// still-running operation's entries at the top of the wizard.
	for i := 1; i < len(rows); i++ {
		for j := i; j > 0 && rows[j].CreatedAt.After(rows[j-1].CreatedAt); j-- {
			rows[j], rows[j-1] = rows[j-1], rows[j]
		}
	}
	if limit > 0 && len(rows) > limit {
		rows = rows[:limit]
	}
	return rows, nil
}

// OpLogger records the steps of ONE activate/deactivate/reload run, grouped
// by OperationID so the frontend wizard can present them as one step with a
// per-line "+Nms" offset from the run's start. A nil *OpLogger is always
// safe to call Log on — every loadModule/applyMigration call site threads an
// OpLogger through, and boot-time calls (which predate any operator-visible
// "operation") simply pass nil.
type OpLogger struct {
	repo        *OpLogRepository
	operationID uuid.UUID
	moduleName  string
	operation   string
	start       time.Time
}

// NewOpLogger starts a new operation for moduleName, generating a fresh
// OperationID and recording the start time the "+Nms" offsets are relative
// to.
func NewOpLogger(repo *OpLogRepository, moduleName, operation string) *OpLogger {
	return &OpLogger{
		repo:        repo,
		operationID: uuid.New(),
		moduleName:  moduleName,
		operation:   operation,
		start:       time.Now(),
	}
}

// Log inserts one log line, best-effort: a broken log write must never fail
// the underlying module operation, so a DB error here falls back to the
// package zap logger instead of propagating. Safe to call on a nil receiver
// (a no-op) so every call site can thread an OpLogger through unconditionally.
func (o *OpLogger) Log(source, level, message string) {
	if o == nil {
		return
	}
	entry := ModuleOperationLog{
		OperationID: o.operationID,
		ModuleName:  o.moduleName,
		Operation:   o.operation,
		Source:      source,
		Level:       level,
		Message:     message,
	}
	// No repo wired (e.g. a Registry built directly in a unit test, without a
	// live DB) — fall back to zap only, same as an insert failure below.
	if o.repo == nil {
		common.Logger.Debug("module operation log (no repo)",
			zap.String("module", o.moduleName), zap.String("message", message))
		return
	}
	if err := o.repo.insert(context.Background(), entry); err != nil {
		common.Logger.Warn("module operation log: insert failed",
			zap.String("module", o.moduleName), zap.String("message", message), zap.Error(err))
	}
}
