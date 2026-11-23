package project

import (
	"context"
	"testing"

	"core/internal/testdb"

	"github.com/jackc/pgx/v5"
)

func TestRaciMigrationArchivesDuplicates(t *testing.T) {
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, testdb.DSN(t))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	// An isolated temporary schema: never drop application indexes in this test.
	_, err = conn.Exec(ctx, `SET search_path TO pg_temp;
 CREATE TEMP TABLE project_task_raci (
 id integer PRIMARY KEY, task_id integer, user_id integer, role text,
 created_at timestamptz, updated_at timestamptz, deleted_at timestamptz);
 INSERT INTO project_task_raci VALUES
 (1,1,1,'A','2026-01-01',NULL,NULL),
 (2,1,1,'R','2026-01-02',NULL,NULL),
 (3,1,2,'A','2026-01-01',NULL,NULL),
 (4,2,1,'C','2026-01-01',NULL,NULL);`)
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if _, err = conn.Exec(ctx, raciSingleRoleMigration); err != nil {
			t.Fatal(err)
		}
	}
	var total, live int
	if err = conn.QueryRow(ctx, `SELECT count(*), count(*) FILTER (WHERE deleted_at IS NULL) FROM project_task_raci`).Scan(&total, &live); err != nil {
		t.Fatal(err)
	}
	if total != 4 || live != 3 {
		t.Fatalf("total=%d live=%d", total, live)
	}
	var role string
	if err = conn.QueryRow(ctx, `SELECT role FROM project_task_raci WHERE task_id=1 AND user_id=1 AND deleted_at IS NULL`).Scan(&role); err != nil || role != "A" {
		t.Fatalf("oldest role=%s err=%v", role, err)
	}
	_, err = conn.Exec(ctx, `INSERT INTO project_task_raci (id,task_id,user_id,role) VALUES (5,1,1,'I')`)
	if pgErr, ok := err.(interface{ SQLState() string }); !ok || pgErr.SQLState() != "23505" {
		t.Fatalf("want unique violation, got %v", err)
	}
}
