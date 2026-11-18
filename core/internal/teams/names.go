package teams

import (
	"context"
	"errors"
	"strconv"
	"strings"

	"core/orm"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// ErrNameTaken is returned when another folder (or file) of the same folder
// already has the name, case ignored.
var ErrNameTaken = errors.New("teams: name already used in this folder")

// Names are unique per folder among folders, and among files, case ignored:
// the uq_team_folder_name / uq_team_file_name indexes enforce it, and every
// write takes the folder's lock first, so two concurrent writes of one name
// can't both pass the check (a double-clicked "New folder" creates one folder).

// lockNames holds folder's (nil = the team root's) name lock until tx ends.
func lockNames(ctx context.Context, tx *orm.Tx, team uuid.UUID, folder *uuid.UUID) error {
	key := "teams.names:" + team.String()
	if folder != nil {
		key += ":" + folder.String()
	}
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, key)
	return err
}

// takenNames locks folder's names and returns the lower-cased names its live
// folders (files: true → its files) use, except the row except.
func takenNames(ctx context.Context, tx *orm.Tx, tenant, team uuid.UUID, folder *uuid.UUID, files bool, except *uuid.UUID) (map[string]bool, error) {
	if err := lockNames(ctx, tx, team, folder); err != nil {
		return nil, err
	}
	q := `SELECT lower(name) FROM team_folder WHERE tenant_id = $1 AND team_id = $2 AND parent_id IS NOT DISTINCT FROM $3
		AND deleted_at IS NULL AND id IS DISTINCT FROM $4`
	if files {
		q = `SELECT lower(name) FROM team_file WHERE tenant_id = $1 AND team_id = $2 AND folder_id IS NOT DISTINCT FROM $3
			AND deleted_at IS NULL AND id IS DISTINCT FROM $4`
	}
	rows, err := tx.Query(ctx, q, tenant, team, folder, except)
	if err != nil {
		return nil, err
	}
	names, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, err
	}
	taken := make(map[string]bool, len(names))
	for _, n := range names {
		taken[n] = true
	}
	return taken, nil
}

// freeName is name, else the first "<base> (n)<ext>" not taken (ext only with
// keepExt: "report (2).pdf"), kept within 200 characters.
func freeName(name string, taken map[string]bool, keepExt bool) string {
	if !taken[strings.ToLower(name)] {
		return name
	}
	base, ext := name, ""
	if i := strings.LastIndex(name, "."); keepExt && i > 0 {
		base, ext = name[:i], name[i:]
	}
	for i := 2; ; i++ {
		suffix := " (" + strconv.Itoa(i) + ")" + ext
		b := []rune(base)
		b = b[:max(0, min(len(b), 200-len([]rune(suffix))))]
		if pick := string(b) + suffix; !taken[strings.ToLower(pick)] {
			return pick
		}
	}
}

// nameErr turns a unique violation of the name indexes into ErrNameTaken.
func nameErr(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" &&
		(pgErr.ConstraintName == "uq_team_folder_name" || pgErr.ConstraintName == "uq_team_file_name") {
		return ErrNameTaken
	}
	return err
}
