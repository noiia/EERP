package module_test

import (
	"context"
	"strings"
	"testing"

	"github.com/google/uuid"

	"core/internal/module"
	"core/internal/testdb"
	"core/orm"
	"core/orm/model"
)

type extendBase struct {
	model.BaseModel
	Name string `db:"name"`
}

type extendChild struct {
	extendBase
	Note *string `db:"note"`
}

type registerFunc struct {
	name string
	fn   func() error
}

func (r registerFunc) Name() string    { return r.name }
func (r registerFunc) Register() error { return r.fn() }

// A module extending a table an earlier module already ensured in the SAME
// Boot() (crminheritdemo re-registering crm) must still get its new columns
// created — they used to be skipped, so every generic INSERT naming them
// failed with "column does not exist".
func TestLoadGoModule_ExtensionInSameBootAddsColumns(t *testing.T) {
	app := testdb.Open(t)
	ctx := context.Background()
	table := "ext_regress_" + strings.ReplaceAll(uuid.NewString()[:8], "-", "")
	t.Cleanup(func() { _, _ = app.DB.Exec(context.Background(), "DROP TABLE IF EXISTS "+table) })

	base := registerFunc{"base", func() error { return orm.Register[extendBase](orm.WithTableName(table)) }}
	child := registerFunc{"child", func() error { return orm.Register[extendChild](orm.WithTableName(table)) }}

	ensured := map[string]int{}
	for _, m := range []module.GoModule{base, child} {
		if _, err := module.LoadGoModule(ctx, app.DB, m, ensured); err != nil {
			t.Fatalf("load %s: %v", m.Name(), err)
		}
	}

	var n int
	if err := app.DB.QueryRow(ctx,
		`SELECT count(*) FROM information_schema.columns WHERE table_name = $1 AND column_name IN ('name', 'note')`,
		table).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("expected name and note columns on %s, found %d", table, n)
	}
}
