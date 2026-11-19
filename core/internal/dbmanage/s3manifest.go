package dbmanage

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// ManifestEntry is one object this database's rows reference (see
// manifestSources) — Table names which row kind it came from, purely for
// legibility; restore doesn't need it (re-uploading is just "put these bytes
// back at this exact key", the key alone is enough).
type ManifestEntry struct {
	Table     string `json:"table"`
	TenantID  string `json:"tenant_id"`
	ObjectKey string `json:"object_key"`
	Mime      string `json:"mime"`
}

// manifestSources are the tables whose rows name an S3 object (tenant_id,
// object_key, mime). A soft-deletable table lists only live rows: deleting a
// Teams file removes its object. A table its module never created in this
// database is skipped.
var manifestSources = []struct {
	table string
	live  bool // filter deleted_at IS NULL
}{
	{"picture", false},
	{"attachment", false},
	{"chat_attachment", true}, // Teams: files of direct conversations
	{"team_file", true},       // Teams: folder files, channel uploads included
}

// BuildManifest queries dbName itself (not necessarily the currently active
// database) for every S3 object it references. Deliberately scoped to the
// rows of manifestSources — generated report PDFs (internal/reports) have no
// durable DB row for their own S3 key at all, so they can never be
// discovered this way; they're always regeneratable on demand from the
// underlying invoice/quote/receipt data, which IS in the SQL dump. Bundling
// only what a DB-side manifest can actually describe (rather than trying to
// enumerate the whole bucket) is what keeps an extraction scoped to exactly
// this database's own objects out of a bucket potentially shared by several
// EERP databases on the same instance.
func BuildManifest(ctx context.Context, conn connInfo, dbName string) ([]ManifestEntry, error) {
	c, err := pgx.Connect(ctx, conn.dsn(dbName))
	if err != nil {
		return nil, fmt.Errorf("dbmanage: connect to %s: %w", dbName, err)
	}
	defer func() { _ = c.Close(ctx) }()

	entries := []ManifestEntry{} // never nil — encodes as JSON [], not null, when empty
	for _, src := range manifestSources {
		var exists bool
		if err := c.QueryRow(ctx, `SELECT to_regclass($1) IS NOT NULL`, "public."+src.table).Scan(&exists); err != nil {
			return nil, fmt.Errorf("dbmanage: look up %s: %w", src.table, err)
		}
		if !exists {
			continue
		}
		where := ""
		if src.live {
			where = " WHERE deleted_at IS NULL"
		}
		// #nosec G201 — table is one of manifestSources' literals, never request input.
		rows, err := c.Query(ctx, fmt.Sprintf(`SELECT tenant_id, object_key, mime FROM %s%s`, src.table, where))
		if err != nil {
			return nil, fmt.Errorf("dbmanage: query %s: %w", src.table, err)
		}
		for rows.Next() {
			e := ManifestEntry{Table: src.table}
			if err := rows.Scan(&e.TenantID, &e.ObjectKey, &e.Mime); err != nil {
				rows.Close()
				return nil, fmt.Errorf("dbmanage: scan %s: %w", src.table, err)
			}
			entries = append(entries, e)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, fmt.Errorf("dbmanage: iterate %s: %w", src.table, err)
		}
	}
	return entries, nil
}
