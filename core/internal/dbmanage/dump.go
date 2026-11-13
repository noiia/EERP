package dbmanage

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"

	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"

	"core/internal/common"
)

// pgDump streams a pg_dump (custom format, -Fc: compressed, selectively
// restorable via pg_restore) of dbName into w. Shells out to the postgresql-
// client tooling (added to core/Dockerfile's runtime stage) rather than
// reimplementing the dump format — the standard, native way to do this.
func pgDump(ctx context.Context, conn connInfo, dbName string, w io.Writer) error {
	// #nosec G204 — every argument is either a fixed flag or comes from
	// connInfo/dbName, both already validated/config-sourced, never raw
	// request input passed straight through.
	cmd := exec.CommandContext(ctx, "pg_dump",
		"-h", conn.Host,
		"-p", fmt.Sprintf("%d", conn.Port),
		"-U", conn.User,
		"-d", dbName,
		"-Fc",
		"--no-owner",
		"--no-privileges",
	)
	cmd.Env = append(os.Environ(), "PGPASSWORD="+conn.Password)
	cmd.Stdout = w
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return fmt.Errorf("dbmanage: pg_dump stderr pipe: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("dbmanage: start pg_dump: %w", err)
	}
	errOutput, _ := io.ReadAll(stderr)
	if err := cmd.Wait(); err != nil {
		return fmt.Errorf("dbmanage: pg_dump %s: %w: %s", dbName, err, errOutput)
	}
	return nil
}

// pgRestore loads a custom-format dump file into an already-created, empty
// database. Extensions the target server doesn't ship are left out (with
// their schemas, see extensionSchemas): a database created by an older
// PostGIS image carries postgis_tiger_geocoder, which PostGIS 3.7 images no
// longer have, and EERP never uses it.
func pgRestore(ctx context.Context, conn connInfo, dbName, dumpPath string) error {
	available, err := availableExtensions(ctx, conn, dbName)
	if err != nil {
		return err
	}
	// #nosec G204 — same reasoning as pgDump above.
	toc, err := exec.CommandContext(ctx, "pg_restore", "-l", dumpPath).Output()
	if err != nil {
		return fmt.Errorf("dbmanage: pg_restore -l: %w", err)
	}
	list, skipped := restoreList(string(toc), available)
	if len(skipped) > 0 && common.Logger != nil {
		common.Logger.Warn("dbmanage: restore skips extensions this server lacks", zap.Strings("extensions", skipped))
	}
	listPath := dumpPath + ".list"
	if err := os.WriteFile(listPath, []byte(list), 0o600); err != nil {
		return fmt.Errorf("dbmanage: write restore list: %w", err)
	}
	// #nosec G204 — same reasoning as pgDump above.
	cmd := exec.CommandContext(ctx, "pg_restore",
		"-h", conn.Host,
		"-p", fmt.Sprintf("%d", conn.Port),
		"-U", conn.User,
		"-d", dbName,
		"--no-owner",
		"--no-privileges",
		"-L", listPath,
		dumpPath,
	)
	cmd.Env = append(os.Environ(), "PGPASSWORD="+conn.Password)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("dbmanage: pg_restore %s: %w: %s", dbName, err, out)
	}
	return nil
}

func availableExtensions(ctx context.Context, conn connInfo, dbName string) (map[string]bool, error) {
	c, err := pgx.Connect(ctx, conn.dsn(dbName))
	if err != nil {
		return nil, fmt.Errorf("dbmanage: connect to %s: %w", dbName, err)
	}
	defer func() { _ = c.Close(ctx) }()
	rows, err := c.Query(ctx, `SELECT name FROM pg_available_extensions`)
	if err != nil {
		return nil, fmt.Errorf("dbmanage: list available extensions: %w", err)
	}
	names, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, fmt.Errorf("dbmanage: list available extensions: %w", err)
	}
	out := make(map[string]bool, len(names))
	for _, n := range names {
		out[n] = true
	}
	return out, nil
}

// extensionSchemas are the schemas an extension creates, dropped with it when
// the target lacks it (pg_dump still writes the schema and its config tables' data).
var extensionSchemas = map[string][]string{
	"postgis_tiger_geocoder": {"tiger", "tiger_data"},
}

// restoreList rewrites a `pg_restore -l` table of contents for pg_restore -L:
// entries of the extensions missing from available are commented out, with
// their comments and schemas (and everything in those schemas). Returns the
// skipped extensions.
func restoreList(toc string, available map[string]bool) (string, []string) {
	var skipped []string
	dropSchema := map[string]bool{}
	lines := strings.Split(toc, "\n")
	for _, l := range lines {
		if typ, _, rest := tocEntry(l); typ == "EXTENSION" && len(rest) > 0 && !available[rest[0]] {
			skipped = append(skipped, rest[0])
			for _, s := range extensionSchemas[rest[0]] {
				dropSchema[s] = true
			}
		}
	}
	if len(skipped) == 0 {
		return toc, nil
	}
	dropExt := map[string]bool{}
	for _, e := range skipped {
		dropExt[e] = true
	}
	for i, l := range lines {
		typ, schema, rest := tocEntry(l)
		drop := dropSchema[schema] ||
			(typ == "EXTENSION" && len(rest) > 0 && dropExt[rest[0]]) ||
			(typ == "SCHEMA" && len(rest) > 0 && dropSchema[rest[0]]) ||
			(typ == "COMMENT" && len(rest) > 1 && ((rest[0] == "EXTENSION" && dropExt[rest[1]]) || (rest[0] == "SCHEMA" && dropSchema[rest[1]])))
		if drop {
			lines[i] = ";" + l
		}
	}
	return strings.Join(lines, "\n"), skipped
}

// tocEntry splits a TOC line ("12; 0 0 TABLE DATA tiger pagc_gaz postgres")
// into its type ("TABLE DATA"), schema ("-" for none) and the remaining words.
// A comment or blank line has no type.
func tocEntry(line string) (typ, schema string, rest []string) {
	head, body, ok := strings.Cut(line, "; ")
	if !ok || strings.HasPrefix(head, ";") || head == "" {
		return "", "", nil
	}
	f := strings.Fields(body)
	if len(f) < 3 {
		return "", "", nil
	}
	f = f[2:] // the two oids
	n := 0
	for n < len(f) && isTypeWord(f[n]) {
		n++
	}
	if n == 0 || n == len(f) {
		return "", "", nil
	}
	return strings.Join(f[:n], " "), f[n], f[n+1:]
}

// isTypeWord: TOC entry types are upper-case words (TABLE, DATA, FK, ...).
func isTypeWord(w string) bool {
	for _, r := range w {
		if r < 'A' || r > 'Z' {
			return false
		}
	}
	return w != ""
}
