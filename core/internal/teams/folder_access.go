package teams

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"

	"core/orm"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/labstack/echo/v5"
)

// ErrFolderLinked: the folder is already linked to another conversation.
var ErrFolderLinked = errors.New("teams: folder already linked to a conversation")

// RestrictingChannel returns the private channel linked to the nearest folder among
// folder and its ancestors, nil when none is: that channel decides who sees the folder.
func (r *Repository) RestrictingChannel(ctx context.Context, tenant, folder uuid.UUID) (*Channel, error) {
	var id uuid.UUID
	err := r.db.QueryRow(ctx, `WITH RECURSIVE up AS (
			SELECT id, parent_id, 0 AS depth FROM team_folder WHERE tenant_id = $1 AND id = $2
			UNION ALL SELECT f.id, f.parent_id, up.depth + 1 FROM team_folder f JOIN up ON f.id = up.parent_id
				WHERE f.tenant_id = $1 AND up.depth < 1000)
		SELECT c.id FROM up JOIN chat_channel c ON c.folder_id = up.id AND c.tenant_id = $1
			AND c.restricted AND c.deleted_at IS NULL
		ORDER BY up.depth LIMIT 1`, tenant, folder).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("teams: restricting channel: %w", err)
	}
	ch, err := r.FindChannel(ctx, tenant, id)
	if err != nil {
		return nil, err
	}
	return &ch, nil
}

// restrictingChain returns every private channel linked to folder or one of its
// ancestors, nearest first: a viewer must see all of them.
func (r *Repository) restrictingChain(ctx context.Context, tenant uuid.UUID, folder *uuid.UUID) ([]Channel, error) {
	var chain []Channel
	for folder != nil && len(chain) < 1000 { // bound: a corrupted cycle can't spin forever
		ch, err := r.RestrictingChannel(ctx, tenant, *folder)
		if err != nil || ch == nil {
			return chain, err
		}
		chain = append(chain, *ch)
		f, err := r.FindFolder(ctx, tenant, *ch.FolderID)
		if err != nil {
			return nil, err
		}
		folder = f.ParentID
	}
	return chain, nil
}

// folderVisible: folder (nil = root) is visible when the user sees every private
// channel linked to it or to one of its ancestors.
func (h *Handler) folderVisible(c *echo.Context, tenant, team, user uuid.UUID, role string, folder *uuid.UUID) (bool, error) {
	return h.visibleFolder(c.Request().Context(), tenant, team, user, role, folder)
}

func (h *Handler) visibleFolder(ctx context.Context, tenant, team, user uuid.UUID, role string, folder *uuid.UUID) (bool, error) {
	if role == RoleOwner {
		return true, nil
	}
	chain, err := h.repo.restrictingChain(ctx, tenant, folder)
	if err != nil {
		return false, err
	}
	for _, ch := range chain {
		if ch.TeamID == nil || *ch.TeamID != team {
			return false, nil
		}
		if ok, err := h.repo.CanSeeChannel(ctx, tenant, ch, user, role); err != nil || !ok {
			return false, err
		}
	}
	return true, nil
}

// splitByFolder splits users into those who see folder and those who don't
// (the intersection of every restricting channel's audience).
func (h *Handler) splitByFolder(ctx context.Context, tenant uuid.UUID, folder *uuid.UUID, users []uuid.UUID) (see, hidden []uuid.UUID, err error) {
	chain, err := h.repo.restrictingChain(ctx, tenant, folder)
	if err != nil {
		return nil, nil, err
	}
	ok := map[uuid.UUID]bool{}
	for _, u := range users {
		ok[u] = true
	}
	for _, ch := range chain {
		aud, err := h.repo.ChannelAudience(ctx, tenant, ch)
		if err != nil {
			return nil, nil, err
		}
		in := map[uuid.UUID]bool{}
		for _, u := range aud {
			in[u] = true
		}
		for u := range ok {
			ok[u] = ok[u] && in[u]
		}
	}
	for _, u := range users {
		if ok[u] {
			see = append(see, u)
		} else {
			hidden = append(hidden, u)
		}
	}
	return see, hidden, nil
}

// HasHiddenDescendant reports whether a folder below folder is linked to a
// private channel user can't see (folder itself already passed folderVisible).
func (r *Repository) HasHiddenDescendant(ctx context.Context, tenant, folder, user uuid.UUID) (bool, error) {
	var hidden bool
	err := r.db.QueryRow(ctx, `WITH RECURSIVE tree AS (
			SELECT id FROM team_folder WHERE tenant_id = $1 AND parent_id = $2
			UNION SELECT f.id FROM team_folder f JOIN tree t ON f.parent_id = t.id WHERE f.tenant_id = $1)
		SELECT EXISTS (SELECT 1 FROM chat_channel c WHERE c.tenant_id = $1 AND c.folder_id IN (SELECT id FROM tree)
			AND c.deleted_at IS NULL AND NOT `+sees("$3")+`)`, tenant, folder, user).Scan(&hidden)
	if err != nil {
		return false, fmt.Errorf("teams: hidden descendant: %w", err)
	}
	return hidden, nil
}

// LinkFolder sets (folder nil: clears) the team channel's linked folder; the
// caller checked the folder is the team's. Only folder_id is written: a full-row
// update could write back a stale restricted.
func (r *Repository) LinkFolder(ctx context.Context, tenant, team, channel uuid.UUID, folder *uuid.UUID) error {
	if _, err := r.findChannel(ctx, tenant, team, channel); err != nil {
		return err
	}
	_, err := r.channels.UpdateQuery().Set("folder_id", folder).Set("updated_at", time.Now()).
		Where(orm.Cond("tenant_id = $1", tenant)).Where(orm.Cond("id = $1", channel)).Exec(ctx, r.db)
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return ErrFolderLinked
	}
	return err
}

// CreateFileMessage records a team-channel message whose uploads become team
// files in the channel's linked folder, creating and linking "<channel name>"
// at the team root when there is none, all in one transaction. The channel row
// lock makes two concurrent sends create one folder.
func (r *Repository) CreateFileMessage(ctx context.Context, m Message, team uuid.UUID, uploads []Attachment) (Message, error) {
	err := orm.Transact(ctx, r.db, func(tx *orm.Tx) error {
		var folder *uuid.UUID
		var name string
		if err := tx.QueryRow(ctx, `SELECT folder_id, name FROM chat_channel WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL
			FOR UPDATE`, m.TenantID, m.ChannelID).Scan(&folder, &name); err != nil {
			return err
		}
		if folder == nil {
			rows, err := tx.Query(ctx, `SELECT name FROM team_folder WHERE tenant_id = $1 AND team_id = $2
				AND parent_id IS NULL AND deleted_at IS NULL`, m.TenantID, team)
			if err != nil {
				return err
			}
			names, err := pgx.CollectRows(rows, pgx.RowTo[string])
			if err != nil {
				return err
			}
			taken := map[string]bool{}
			for _, n := range names {
				taken[n] = true
			}
			pick := name
			for i := 2; taken[pick]; i++ {
				suffix := " (" + strconv.Itoa(i) + ")"
				base := []rune(name)
				base = base[:min(len(base), 200-len(suffix))] // "<base> (n)" stays a valid name
				pick = string(base) + suffix
			}
			f, err := r.folders.WithTx(tx).Create(ctx, Folder{TenantID: m.TenantID, TeamID: team, Name: pick, CreatedBy: m.AuthorID})
			if err != nil {
				return err
			}
			folder = &f.ID
			if _, err := tx.Exec(ctx, `UPDATE chat_channel SET folder_id = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2`,
				m.TenantID, m.ChannelID, f.ID); err != nil {
				return err
			}
		}
		var err error
		if m, err = r.messages.WithTx(tx).Create(ctx, m); err != nil {
			return err
		}
		for _, a := range uploads {
			f, err := r.files.WithTx(tx).Create(ctx, File{TenantID: m.TenantID, TeamID: team, FolderID: folder, Name: a.Filename,
				Mime: a.Mime, Size: a.Size, ObjectKey: a.ObjectKey, UploadedBy: m.AuthorID})
			if err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `INSERT INTO chat_message_file (tenant_id, message_id, file_id) VALUES ($1, $2, $3)`,
				m.TenantID, m.ID, f.ID); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return Message{}, fmt.Errorf("teams: create file message: %w", err)
	}
	return m, nil
}

// messageFile is one file sent with a message; Deleted once the team file is gone.
type messageFile struct {
	FileID   uuid.UUID
	Name     string
	Mime     string
	Size     int64
	Deleted  bool
	FolderID *uuid.UUID
	TeamID   *uuid.UUID
}

// MessageFilesOf groups the messages' sent files by message id, in send order.
func (r *Repository) MessageFilesOf(ctx context.Context, tenant uuid.UUID, messages []uuid.UUID) (map[uuid.UUID][]messageFile, error) {
	out := map[uuid.UUID][]messageFile{}
	if len(messages) == 0 {
		return out, nil
	}
	rows, err := r.db.Query(ctx, `SELECT mf.message_id, mf.file_id, coalesce(f.name, ''), coalesce(f.mime, ''), coalesce(f.size, 0), f.id IS NULL, f.folder_id, f.team_id
		FROM chat_message_file mf LEFT JOIN team_file f ON f.id = mf.file_id AND f.tenant_id = $1 AND f.deleted_at IS NULL
		WHERE mf.tenant_id = $1 AND mf.message_id = ANY($2) AND mf.deleted_at IS NULL
		ORDER BY mf.created_at, mf.id`, tenant, messages)
	if err != nil {
		return nil, fmt.Errorf("teams: message files: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id uuid.UUID
		var f messageFile
		if err := rows.Scan(&id, &f.FileID, &f.Name, &f.Mime, &f.Size, &f.Deleted, &f.FolderID, &f.TeamID); err != nil {
			return nil, fmt.Errorf("teams: message files: %w", err)
		}
		out[id] = append(out[id], f)
	}
	return out, rows.Err()
}
