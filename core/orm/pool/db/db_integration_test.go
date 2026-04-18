package db_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"

	"core/internal/common"
	"core/internal/types"
	"core/orm/pool/config"
	"core/orm/pool/db"
	"core/orm/pool/tx"
)

func testDSN(t *testing.T) string {
	t.Helper()

	configFile := os.Getenv("CONFIG")

	t.Log(configFile)
	configContent, err := common.DecodeJSON[*types.Config](configFile)
	if err != nil {
		t.Error("❌ Error reading config file:", err)
	}

	dsn := fmt.Sprintf("postgres://%s:%s@%s:%d/%s", configContent.DbUser, configContent.DbPassword, configContent.DbHost, configContent.DbPort, configContent.DbName)

	t.Log(dsn)
	if dsn == "" {
		t.Skip("TEST_DSN not set — skipping integration test")
	}
	return dsn
}

func openTestDB(t *testing.T) *db.DB {
	t.Helper()
	var dsn string

	if dsn == "" {
		dsn = testDSN(t)
	}

	db, err := db.Open(context.Background(), config.Config{
		DSN:   dsn,
		Debug: true,
	})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(db.Close)
	return db
}

// ── Open / Close ──────────────────────────────────────────────────────────────

func TestIntegration_Open_Ping(t *testing.T) {
	t.Parallel()

	db := openTestDB(t)
	if db == nil {
		t.Fatal("expected non-nil DB")
	}
}

// ── Query ─────────────────────────────────────────────────────────────────────

func TestIntegration_Query_SelectOne(t *testing.T) {
	t.Parallel()

	db := openTestDB(t)
	rows, err := db.Query(context.Background(), "SELECT 1 AS n")
	if err != nil {
		t.Fatalf("Query: %v", err)
	}
	defer rows.Close()

	if !rows.Next() {
		t.Fatal("expected at least one row")
	}
	var n int
	if err := rows.Scan(&n); err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if n != 1 {
		t.Errorf("got %d, want 1", n)
	}
}

// ── QueryRow ──────────────────────────────────────────────────────────────────

func TestIntegration_QueryRow(t *testing.T) {
	t.Parallel()

	db := openTestDB(t)
	var n int
	err := db.QueryRow(context.Background(), "SELECT 42").Scan(&n)
	if err != nil {
		t.Fatalf("QueryRow.Scan: %v", err)
	}
	if n != 42 {
		t.Errorf("got %d, want 42", n)
	}
}

// ── Exec ──────────────────────────────────────────────────────────────────────

func TestIntegration_Exec_CreateDropTable(t *testing.T) {
	t.Parallel()

	db := openTestDB(t)
	ctx := context.Background()

	_, err := db.Exec(ctx, `CREATE TEMP TABLE _orm_test_exec (id INT)`)
	if err != nil {
		t.Fatalf("CREATE TABLE: %v", err)
	}
	t.Cleanup(func() {
		db.Exec(ctx, `DROP TABLE IF EXISTS _orm_test_exec`)
	})

	tag, err := db.Exec(ctx, `INSERT INTO _orm_test_exec VALUES (1)`)
	if err != nil {
		t.Fatalf("INSERT: %v", err)
	}
	if tag.RowsAffected() != 1 {
		t.Errorf("RowsAffected = %d, want 1", tag.RowsAffected())
	}
}

// ── Transaction — commit ──────────────────────────────────────────────────────

func TestIntegration_Transaction_Commit(t *testing.T) {
	t.Parallel()

	db := openTestDB(t)
	ctx := context.Background()

	db.Exec(ctx, `CREATE TEMP TABLE _orm_test_tx (id INT)`)
	t.Cleanup(func() { db.Exec(ctx, `DROP TABLE IF EXISTS _orm_test_tx`) })

	err := db.Transaction(ctx, func(tx *tx.Tx) error {
		_, err := tx.Exec(ctx, `INSERT INTO _orm_test_tx VALUES (1)`)
		return err
	})
	if err != nil {
		t.Fatalf("Transaction: %v", err)
	}

	var count int
	db.QueryRow(ctx, `SELECT COUNT(*) FROM _orm_test_tx`).Scan(&count)
	if count != 1 {
		t.Errorf("after commit: count = %d, want 1", count)
	}
}

// ── Transaction — rollback on error ──────────────────────────────────────────

func TestIntegration_Transaction_Rollback(t *testing.T) {
	t.Parallel()

	db := openTestDB(t)
	ctx := context.Background()

	db.Exec(ctx, `CREATE TEMP TABLE _orm_test_rb (id INT)`)
	t.Cleanup(func() { db.Exec(ctx, `DROP TABLE IF EXISTS _orm_test_rb`) })

	boom := errors.New("intentional rollback")
	err := db.Transaction(ctx, func(tx *tx.Tx) error {
		tx.Exec(ctx, `INSERT INTO _orm_test_rb VALUES (99)`)
		return boom
	})
	if !errors.Is(err, boom) {
		t.Fatalf("expected boom error, got %v", err)
	}

	var count int
	db.QueryRow(ctx, `SELECT COUNT(*) FROM _orm_test_rb`).Scan(&count)
	if count != 0 {
		t.Errorf("after rollback: count = %d, want 0", count)
	}
}

// ── Transaction — savepoint ───────────────────────────────────────────────────

func TestIntegration_Transaction_Savepoint(t *testing.T) {
	t.Parallel()

	db := openTestDB(t)
	ctx := context.Background()

	db.Exec(ctx, `CREATE TEMP TABLE _orm_test_sp (id INT)`)
	t.Cleanup(func() { db.Exec(ctx, `DROP TABLE IF EXISTS _orm_test_sp`) })

	err := db.Transaction(ctx, func(tx *tx.Tx) error {
		// Outer insert — should survive.
		if _, err := tx.Exec(ctx, `INSERT INTO _orm_test_sp VALUES (1)`); err != nil {
			return err
		}

		// Savepoint before risky nested operation.
		if err := tx.Savepoint(ctx, "inner"); err != nil {
			return err
		}

		// Nested insert — will be rolled back.
		tx.Exec(ctx, `INSERT INTO _orm_test_sp VALUES (2)`)
		if err := tx.RollbackTo(ctx, "inner"); err != nil {
			return err
		}
		if err := tx.Release(ctx, "inner"); err != nil {
			return err
		}

		return nil // commit outer
	})
	if err != nil {
		t.Fatalf("Transaction: %v", err)
	}

	var count int
	db.QueryRow(ctx, `SELECT COUNT(*) FROM _orm_test_sp`).Scan(&count)
	if count != 1 {
		t.Errorf("after savepoint rollback: count = %d, want 1 (outer row only)", count)
	}
}
