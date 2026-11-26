package teams

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"

	"core/orm"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// HashToken is what a link stores of its token: a leaked table can't be replayed.
func HashToken(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

const linkColumns = `id, tenant_id, team_id, file_id, created_by, token_hash, expires_at, download_count, last_download_at, created_at, updated_at`

// liveLink: not revoked and not expired.
const liveLink = `deleted_at IS NULL AND expires_at > now()`

func scanLink(row pgx.Row) (Link, error) {
	var l Link
	err := row.Scan(&l.ID, &l.TenantID, &l.TeamID, &l.FileID, &l.CreatedBy, &l.TokenHash, &l.ExpiresAt,
		&l.DownloadCount, &l.LastDownloadAt, &l.CreatedAt, &l.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Link{}, orm.ErrNotFound
	}
	return l, err
}

func (r *Repository) CreateLink(ctx context.Context, l Link) (Link, error) {
	created, err := r.links.Create(ctx, l)
	if err != nil {
		return Link{}, fmt.Errorf("teams: create link: %w", err)
	}
	return created, nil
}

// ListLinks returns the file's live links, newest first.
func (r *Repository) ListLinks(ctx context.Context, tenant, file uuid.UUID) ([]Link, error) {
	rows, err := r.db.Query(ctx, `SELECT `+linkColumns+` FROM team_file_link
		WHERE tenant_id=$1 AND file_id=$2 AND `+liveLink+` ORDER BY created_at DESC`, tenant, file)
	if err != nil {
		return nil, fmt.Errorf("teams: list links: %w", err)
	}
	defer rows.Close()
	out := []Link{}
	for rows.Next() {
		l, err := scanLink(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// FindLink returns a live link of the tenant, orm.ErrNotFound otherwise.
func (r *Repository) FindLink(ctx context.Context, tenant, id uuid.UUID) (Link, error) {
	return scanLink(r.db.QueryRow(ctx, `SELECT `+linkColumns+` FROM team_file_link
		WHERE tenant_id=$1 AND id=$2 AND `+liveLink, tenant, id))
}

// ResolveLink finds a live link by token hash in any tenant: the caller checks the tenant.
func (r *Repository) ResolveLink(ctx context.Context, tokenHash string) (Link, error) {
	return scanLink(r.db.QueryRow(ctx, `SELECT `+linkColumns+` FROM team_file_link
		WHERE token_hash=$1 AND `+liveLink, tokenHash))
}

func (r *Repository) RevokeLink(ctx context.Context, tenant, id uuid.UUID) error {
	if _, err := r.db.Exec(ctx, `UPDATE team_file_link SET deleted_at=now(), updated_at=now()
		WHERE tenant_id=$1 AND id=$2 AND deleted_at IS NULL`, tenant, id); err != nil {
		return fmt.Errorf("teams: revoke link: %w", err)
	}
	return nil
}

func (r *Repository) CountDownload(ctx context.Context, tenant, id uuid.UUID) error {
	if _, err := r.db.Exec(ctx, `UPDATE team_file_link SET download_count=download_count+1, last_download_at=now()
		WHERE tenant_id=$1 AND id=$2`, tenant, id); err != nil {
		return fmt.Errorf("teams: count download: %w", err)
	}
	return nil
}
