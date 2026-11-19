package crud_test

import (
	"context"
	"errors"
	"testing"

	"core/orm/access"
	"core/orm/internal/crud"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
)

var errDown = errors.New("database down")

// failingExec fails the way a lost database does. scanOnly keeps queries
// "succeeding" but fails reading their rows, the other half of every read path.
type failingExec struct{ scanOnly bool }

func (e failingExec) Query(context.Context, string, ...any) (pgx.Rows, error) {
	if e.scanOnly {
		return &failingRows{}, nil
	}
	return nil, errDown
}

func (e failingExec) QueryRow(context.Context, string, ...any) pgx.Row { return failingRow{} }

func (e failingExec) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, errDown
}

type failingRow struct{}

func (failingRow) Scan(...any) error { return errDown }

// failingRows yields one row whose Scan fails.
type failingRows struct{ done bool }

func (r *failingRows) Close()                                       {}
func (r *failingRows) Err() error                                   { return nil }
func (r *failingRows) CommandTag() pgconn.CommandTag                { return pgconn.CommandTag{} }
func (r *failingRows) FieldDescriptions() []pgconn.FieldDescription { return nil }
func (r *failingRows) Next() bool                                   { n := !r.done; r.done = true; return n }
func (r *failingRows) Scan(...any) error                            { return errDown }
func (r *failingRows) Values() ([]any, error)                       { return nil, errDown }
func (r *failingRows) RawValues() [][]byte                          { return nil }
func (r *failingRows) Conn() *pgx.Conn                              { return nil }
func (r *failingRows) TypeMap() *pgtype.Map                         { return pgtype.NewMap() }

// Every generic CRUD operation surfaces a database failure as an error — the
// generic handler turns it into a 500, never an empty 200.
func TestRepository_DatabaseFailures(t *testing.T) {
	ctx := access.WithTenant(context.Background(), uuid.New())
	id := uuid.New()
	for name, ex := range map[string]failingExec{"query fails": {}, "scan fails": {scanOnly: true}} {
		t.Run(name, func(t *testing.T) {
			repo := crud.NewRepository(ex, tenantMeta(t))
			calls := map[string]func() error{
				"FindAll":        func() error { _, _, err := repo.FindAll(ctx, crud.ListFilter{Page: 1, PageSize: 20}); return err },
				"DistinctValues": func() error { _, err := repo.DistinctValues(ctx, "label", crud.ListFilter{}); return err },
				"FindByID":       func() error { _, err := repo.FindByID(ctx, id); return err },
				"Create":         func() error { _, err := repo.Create(ctx, map[string]any{"label": "x"}); return err },
				"Update":         func() error { _, err := repo.Update(ctx, id, map[string]any{"label": "x"}); return err },
				"Delete":         func() error { return repo.Delete(ctx, id) },
				"Restore":        func() error { _, err := repo.Restore(ctx, id); return err },
			}
			for op, call := range calls {
				if err := call(); err == nil {
					t.Errorf("%s: want an error", op)
				}
			}
		})
	}

	t.Run("a create with no column to write", func(t *testing.T) {
		repo := crud.NewRepository(failingExec{}, tenantMeta(t))
		if _, err := repo.Create(ctx, map[string]any{}); err == nil {
			t.Fatal("want an error")
		}
	})
	t.Run("a global table's delete", func(t *testing.T) {
		repo := crud.NewRepository(failingExec{}, globalMeta(t))
		if err := repo.Delete(context.Background(), id); err == nil {
			t.Fatal("want an error")
		}
	})
}
