package dbmanage

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
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
// database.
func pgRestore(ctx context.Context, conn connInfo, dbName, dumpPath string) error {
	// #nosec G204 — same reasoning as pgDump above.
	cmd := exec.CommandContext(ctx, "pg_restore",
		"-h", conn.Host,
		"-p", fmt.Sprintf("%d", conn.Port),
		"-U", conn.User,
		"-d", dbName,
		"--no-owner",
		"--no-privileges",
		dumpPath,
	)
	cmd.Env = append(os.Environ(), "PGPASSWORD="+conn.Password)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("dbmanage: pg_restore %s: %w: %s", dbName, err, out)
	}
	return nil
}
