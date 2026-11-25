package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"testing"

	"core/internal/common"
	"core/internal/dbmanage"
	"core/internal/testdb"
	"core/internal/types"

	"github.com/jackc/pgx/v5"
)

func TestMain(m *testing.M) {
	_ = common.InitLogger(false)
	os.Exit(m.Run())
}

func testConfig(t *testing.T) *types.Config { return testdb.Config(t) }

// freshDB creates and provisions a throwaway database, dropped at cleanup.
func freshDB(t *testing.T, cfg *types.Config) string {
	t.Helper()
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	name := "eerp_upgrade_t_" + hex.EncodeToString(b)
	ctx := context.Background()
	conn := dbmanage.ConnFromConfig(cfg)
	if err := dbmanage.CreateDatabase(ctx, conn, name); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = dbmanage.DropDatabase(context.Background(), conn, name, cfg.DbName) })
	if err := provision(ctx, cfg, name); err != nil {
		t.Fatal(err)
	}
	return name
}

func snapshot(t *testing.T, cfg *types.Config, name string, exec ...string) Schema {
	t.Helper()
	ctx := context.Background()
	c, err := pgx.Connect(ctx, dbmanage.ConnFromConfig(cfg).DSN(name))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close(ctx)
	for _, q := range exec {
		if _, err := c.Exec(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	s, err := loadSchema(ctx, c)
	if err != nil {
		t.Fatal(err)
	}
	return s
}
