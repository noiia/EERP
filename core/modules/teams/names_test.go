package teams

import (
	"context"
	"strings"
	"testing"

	"core/internal/testdb"

	"github.com/google/uuid"
)

// The one-time rename that lets the unique name index be built over older rows.
func TestUniqueNames_RenamesClashesThenIndexes(t *testing.T) {
	app := testdb.Open(t)
	ctx := context.Background()
	table := "tmp_names_" + strings.ReplaceAll(uuid.NewString()[:8], "-", "")
	index := "uq_" + table
	if _, err := app.DB.Exec(ctx, `CREATE TABLE `+table+` (id uuid PRIMARY KEY, tenant_id uuid, team_id uuid, folder_id uuid,
		name text, created_at timestamptz, updated_at timestamptz, deleted_at timestamptz)`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = app.DB.Exec(ctx, `DROP TABLE `+table) })
	tenant, team := uuid.New(), uuid.New()
	ids := []uuid.UUID{uuid.New(), uuid.New(), uuid.New(), uuid.New()}
	for i, n := range []string{"a.pdf", "A.pdf", "notes", "Notes"} {
		if _, err := app.DB.Exec(ctx, `INSERT INTO `+table+` VALUES ($1,$2,$3,NULL,$4, now() + $5 * interval '1 second', now(), NULL)`,
			ids[i], tenant, team, n, i); err != nil {
			t.Fatal(err)
		}
	}
	for range 2 { // idempotent
		if _, err := app.DB.Exec(ctx, uniqueNames(table, "folder_id", index, true)); err != nil {
			t.Fatal(err)
		}
	}
	names := map[uuid.UUID]string{}
	rows, _ := app.DB.Query(ctx, `SELECT id, name FROM `+table)
	for rows.Next() {
		var id uuid.UUID
		var n string
		_ = rows.Scan(&id, &n)
		names[id] = n
	}
	rows.Close()
	if names[ids[0]] != "a.pdf" || names[ids[1]] != "A ("+ids[1].String()[:8]+").pdf" ||
		names[ids[2]] != "notes" || names[ids[3]] != "Notes ("+ids[3].String()[:8]+")" {
		t.Fatalf("names: %v", names)
	}
	_, err := app.DB.Exec(ctx, `INSERT INTO `+table+` VALUES ($1,$2,$3,NULL,'A.PDF', now(), now(), NULL)`, uuid.New(), tenant, team)
	if err == nil || !strings.Contains(err.Error(), index) {
		t.Fatalf("index missing: %v", err)
	}
}

