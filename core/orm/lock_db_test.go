package orm_test

import (
	"context"
	"errors"
	"testing"

	"core/internal/testdb"
	"core/orm"
	"core/orm/model"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

// ormLockFixture is a throwaway table (dropped after the test) for proving
// SelectForUpdate's locks against a second, concurrent transaction.
type ormLockFixture struct {
	model.BaseModel
	Name string `db:"name"`
}

func TestSelectForUpdate_LocksAgainstConcurrentTx(t *testing.T) {
	app := testdb.Open(t)
	ctx := context.Background()
	if err := orm.Register[ormLockFixture](); err != nil {
		t.Fatal(err)
	}
	testdb.Migrate(t, app, "orm_lock_fixture")
	t.Cleanup(func() { _, _ = app.DB.Exec(ctx, `DROP TABLE IF EXISTS orm_lock_fixture`) })

	repo := orm.MustRepo[ormLockFixture](app.DB)
	tenant := uuid.New()
	var ids []uuid.UUID
	for _, name := range []string{"a", "b"} {
		row, err := repo.Create(ctx, ormLockFixture{BaseModel: model.BaseModel{TenantID: tenant}, Name: name})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, row.ID)
	}
	mine := orm.Cond("tenant_id = $1", tenant)

	if _, err := repo.SelectForUpdate().Where(mine).All(ctx, app.DB); !errors.Is(err, orm.ErrLockOutsideTx) {
		t.Fatalf("outside a tx: err = %v, want ErrLockOutsideTx", err)
	}

	err := orm.Transact(ctx, app.DB, func(tx1 *orm.Tx) error {
		locked, err := repo.SelectForUpdate().Where(mine).Where(orm.Cond("id = $1", ids[0])).One(ctx, tx1)
		if err != nil || locked.Name != "a" {
			t.Fatalf("lock a: %v %+v", err, locked)
		}
		return orm.Transact(ctx, app.DB, func(tx2 *orm.Tx) error {
			// A second worker skipping locked rows only sees b.
			free, err := orm.SelectForUpdate[ormLockFixture](repo.Meta()).SkipLocked().Where(mine).All(ctx, tx2)
			if err != nil {
				t.Fatal(err)
			}
			if len(free) != 1 || free[0].Name != "b" {
				t.Errorf("skip locked = %+v, want only b", free)
			}
			// NOWAIT on the locked row fails at once with lock_not_available.
			_, err = repo.SelectForUpdate().NoWait().Where(orm.Cond("id = $1", ids[0])).One(ctx, tx2)
			var pgErr *pgconn.PgError
			if !errors.As(err, &pgErr) || pgErr.Code != "55P03" {
				t.Errorf("nowait on locked row: err = %v, want 55P03", err)
			}
			return errors.New("rollback tx2") // its NOWAIT error aborted it anyway
		})
	})
	if err == nil {
		t.Fatal("expected tx2's rollback error to propagate")
	}
}
