package backup

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// lockKey serializes backup runs across every core-back process sharing the
// Postgres server (schema lock 7311990001, search index 7311990002).
const lockKey int64 = 7311990003

// Locker grants the one backup run allowed at a time.
type Locker interface {
	TryLock(ctx context.Context) (unlock func(), ok bool, err error)
}

// PGLocker takes a session advisory lock on its own connection — to the
// server's `postgres` database (dbmanage.Manager.MaintenanceConn), which no
// database switch touches. Held until unlock, or until the connection dies
// with the process.
func PGLocker(connect func(context.Context) (*pgx.Conn, error)) Locker {
	return pgLocker{connect: connect}
}

type pgLocker struct {
	connect func(context.Context) (*pgx.Conn, error)
}

func (l pgLocker) TryLock(ctx context.Context) (func(), bool, error) {
	conn, err := l.connect(ctx)
	if err != nil {
		return nil, false, fmt.Errorf("backup: lock connection: %w", err)
	}
	var ok bool
	if err := conn.QueryRow(ctx, `SELECT pg_try_advisory_lock($1)`, lockKey).Scan(&ok); err != nil || !ok {
		_ = conn.Close(ctx)
		if err != nil {
			return nil, false, fmt.Errorf("backup: take lock: %w", err)
		}
		return nil, false, nil
	}
	return func() {
		bg := context.Background()
		_, _ = conn.Exec(bg, `SELECT pg_advisory_unlock($1)`, lockKey)
		_ = conn.Close(bg)
	}, true, nil
}
