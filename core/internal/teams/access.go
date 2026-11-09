package teams

import (
	"context"
	"errors"
	"fmt"

	"core/orm"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

var (
	// ErrOutsideTeam: a user id that isn't a team member, or a group id that isn't one of the team's groups.
	ErrOutsideTeam = errors.New("teams: id outside the team")
	ErrGroupExists = errors.New("teams: a group with this name already exists")
)

// sees is THE visibility rule's SQL (owners aside): channel c isn't restricted or
// lists user directly or through a group. user is a SQL expression.
func sees(user string) string {
	return `(NOT c.restricted
		OR EXISTS (SELECT 1 FROM chat_channel_access a WHERE a.channel_id = c.id AND a.deleted_at IS NULL
			AND (a.user_id = ` + user + ` OR a.group_id IN (SELECT gm.group_id FROM team_group_member gm
				WHERE gm.user_id = ` + user + ` AND gm.deleted_at IS NULL))))`
}

// VisibleChannelIDs returns the team's channels user (holding role) can see; every one for an owner.
func (r *Repository) VisibleChannelIDs(ctx context.Context, tenant, team, user uuid.UUID, role string) (map[uuid.UUID]bool, error) {
	out := map[uuid.UUID]bool{}
	if !CanRead(role) {
		return out, nil
	}
	rows, err := r.db.Query(ctx, `SELECT c.id FROM chat_channel c WHERE c.tenant_id = $1 AND c.team_id = $2
		AND c.kind = 'channel' AND c.deleted_at IS NULL AND ($4 OR `+sees("$3")+`)`, tenant, team, user, role == RoleOwner)
	if err != nil {
		return nil, fmt.Errorf("teams: visible channels: %w", err)
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
	if err != nil {
		return nil, fmt.Errorf("teams: visible channels: %w", err)
	}
	for _, id := range ids {
		out[id] = true
	}
	return out, nil
}

// CanSeeChannel applies the visibility rule to one team channel: owner, open, or listed.
func (r *Repository) CanSeeChannel(ctx context.Context, tenant uuid.UUID, ch Channel, user uuid.UUID, role string) (bool, error) {
	if ch.TeamID == nil || !CanRead(role) {
		return false, nil
	}
	var ok bool
	err := r.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM chat_channel c WHERE c.tenant_id = $1 AND c.id = $2
		AND c.deleted_at IS NULL AND ($4 OR `+sees("$3")+`))`, tenant, ch.ID, user, role == RoleOwner).Scan(&ok)
	if err != nil {
		return false, fmt.Errorf("teams: can see channel: %w", err)
	}
	return ok, nil
}

// ChannelAudience returns the team members who can see the team channel: owners plus
// everyone when the list is empty, else the listed users and group members.
func (r *Repository) ChannelAudience(ctx context.Context, tenant uuid.UUID, ch Channel) ([]uuid.UUID, error) {
	rows, err := r.db.Query(ctx, `SELECT m.user_id FROM team_member m JOIN chat_channel c ON c.team_id = m.team_id
		WHERE c.tenant_id = $1 AND c.id = $2 AND m.tenant_id = $1 AND m.deleted_at IS NULL
		AND (m.role = 'owner' OR `+sees("m.user_id")+`)`, tenant, ch.ID)
	if err != nil {
		return nil, fmt.Errorf("teams: channel audience: %w", err)
	}
	return pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
}

// GroupView is a group with its members, also the wire shape.
type GroupView struct {
	ID      uuid.UUID   `json:"id"`
	Name    string      `json:"name"`
	UserIDs []uuid.UUID `json:"user_ids"`
}

const groupSelect = `SELECT g.id, g.name, coalesce(array_agg(gm.user_id ORDER BY gm.user_id) FILTER (WHERE gm.user_id IS NOT NULL), '{}')
	FROM team_group g LEFT JOIN team_group_member gm ON gm.group_id = g.id AND gm.deleted_at IS NULL
	WHERE g.tenant_id = $1 AND g.team_id = $2 AND g.deleted_at IS NULL`

func scanGroups(rows pgx.Rows) ([]GroupView, error) {
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (GroupView, error) {
		var g GroupView
		err := row.Scan(&g.ID, &g.Name, &g.UserIDs)
		return g, err
	})
}

func (r *Repository) ListGroups(ctx context.Context, tenant, team uuid.UUID) ([]GroupView, error) {
	rows, err := r.db.Query(ctx, groupSelect+` GROUP BY g.id, g.name ORDER BY lower(g.name), g.id`, tenant, team)
	if err != nil {
		return nil, fmt.Errorf("teams: list groups: %w", err)
	}
	return scanGroups(rows)
}

// lockTeam takes the team row lock RemoveMember also takes (changeMember), so a
// membership check can't race a removal.
func lockTeam(ctx context.Context, tx *orm.Tx, tenant, team uuid.UUID) error {
	_, err := tx.Exec(ctx, `SELECT 1 FROM team WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, team, tenant)
	return err
}

// allMembers checks every user is a live member of the team.
func allMembers(ctx context.Context, tx *orm.Tx, tenant, team uuid.UUID, users []uuid.UUID) error {
	var missing bool
	err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM unnest($3::uuid[]) u WHERE NOT EXISTS (SELECT 1 FROM team_member m
		WHERE m.tenant_id = $1 AND m.team_id = $2 AND m.user_id = u AND m.deleted_at IS NULL))`, tenant, team, users).Scan(&missing)
	if err == nil && missing {
		err = ErrOutsideTeam
	}
	return err
}

// SaveGroup creates (id nil) or renames the group and replaces its members, who must be team members.
func (r *Repository) SaveGroup(ctx context.Context, tenant, team uuid.UUID, id *uuid.UUID, name string, users []uuid.UUID) (GroupView, error) {
	name, err := validName(name)
	if err != nil {
		return GroupView{}, err
	}
	if users == nil {
		users = []uuid.UUID{}
	}
	var gid uuid.UUID
	err = orm.Transact(ctx, r.db, func(tx *orm.Tx) error {
		if err := lockTeam(ctx, tx, tenant, team); err != nil {
			return err
		}
		if err := allMembers(ctx, tx, tenant, team, users); err != nil {
			return err
		}
		if id == nil {
			err = tx.QueryRow(ctx, `INSERT INTO team_group (tenant_id, team_id, name) VALUES ($1, $2, $3) RETURNING id`,
				tenant, team, name).Scan(&gid)
		} else {
			err = tx.QueryRow(ctx, `UPDATE team_group SET name = $4, updated_at = now()
				WHERE tenant_id = $1 AND team_id = $2 AND id = $3 AND deleted_at IS NULL RETURNING id`, tenant, team, *id, name).Scan(&gid)
		}
		if errors.Is(err, pgx.ErrNoRows) {
			return orm.ErrNotFound
		}
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM team_group_member WHERE tenant_id = $1 AND group_id = $2`, tenant, gid); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `INSERT INTO team_group_member (tenant_id, group_id, user_id)
			SELECT $1, $2, u FROM unnest($3::uuid[]) AS u ON CONFLICT DO NOTHING`, tenant, gid, users)
		return err
	})
	var pgErr *pgconn.PgError
	switch {
	case errors.As(err, &pgErr) && pgErr.Code == "23505":
		return GroupView{}, ErrGroupExists
	case errors.Is(err, orm.ErrNotFound), errors.Is(err, ErrOutsideTeam):
		return GroupView{}, err
	case err != nil:
		return GroupView{}, fmt.Errorf("teams: save group: %w", err)
	}
	rows, err := r.db.Query(ctx, groupSelect+` AND g.id = $3 GROUP BY g.id, g.name`, tenant, team, gid)
	if err != nil {
		return GroupView{}, fmt.Errorf("teams: read group: %w", err)
	}
	return first(scanGroups(rows))
}

// DeleteGroup removes the group, its members and its channel access entries.
func (r *Repository) DeleteGroup(ctx context.Context, tenant, team, id uuid.UUID) error {
	err := orm.Transact(ctx, r.db, func(tx *orm.Tx) error {
		tag, err := tx.Exec(ctx, `DELETE FROM team_group WHERE tenant_id = $1 AND team_id = $2 AND id = $3`, tenant, team, id)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return orm.ErrNotFound
		}
		for _, q := range []string{
			`DELETE FROM team_group_member WHERE tenant_id = $1 AND group_id = $2`,
			`DELETE FROM chat_channel_access WHERE tenant_id = $1 AND group_id = $2`,
		} {
			if _, err := tx.Exec(ctx, q, tenant, id); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil && !errors.Is(err, orm.ErrNotFound) {
		return fmt.Errorf("teams: delete group: %w", err)
	}
	return err
}

// AccessList returns the channel's listed users and groups (both empty = open).
func (r *Repository) AccessList(ctx context.Context, tenant, channel uuid.UUID) (users, groups []uuid.UUID, err error) {
	users, groups = []uuid.UUID{}, []uuid.UUID{}
	rows, err := r.db.Query(ctx, `SELECT user_id, group_id FROM chat_channel_access
		WHERE tenant_id = $1 AND channel_id = $2 AND deleted_at IS NULL ORDER BY created_at, id`, tenant, channel)
	if err != nil {
		return nil, nil, fmt.Errorf("teams: access list: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var u, g *uuid.UUID
		if err := rows.Scan(&u, &g); err != nil {
			return nil, nil, fmt.Errorf("teams: access list: %w", err)
		}
		if u != nil {
			users = append(users, *u)
		} else if g != nil {
			groups = append(groups, *g)
		}
	}
	return users, groups, rows.Err()
}

// SetAccessList replaces the team channel's whole access list; users must be team
// members and groups the team's own. It is the only writer of restricted: an
// explicit empty list is what reopens a channel.
func (r *Repository) SetAccessList(ctx context.Context, tenant, team, channel uuid.UUID, users, groups []uuid.UUID) error {
	if users == nil {
		users = []uuid.UUID{}
	}
	if groups == nil {
		groups = []uuid.UUID{}
	}
	err := orm.Transact(ctx, r.db, func(tx *orm.Tx) error {
		if err := lockTeam(ctx, tx, tenant, team); err != nil {
			return err
		}
		if err := allMembers(ctx, tx, tenant, team, users); err != nil {
			return err
		}
		var missing bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM unnest($3::uuid[]) g WHERE NOT EXISTS (SELECT 1 FROM team_group t
			WHERE t.tenant_id = $1 AND t.team_id = $2 AND t.id = g AND t.deleted_at IS NULL))`, tenant, team, groups).Scan(&missing); err != nil {
			return err
		}
		if missing {
			return ErrOutsideTeam
		}
		if _, err := tx.Exec(ctx, `UPDATE chat_channel SET restricted = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2`,
			tenant, channel, len(users)+len(groups) > 0); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM chat_channel_access WHERE tenant_id = $1 AND channel_id = $2`, tenant, channel); err != nil {
			return err
		}
		for col, ids := range map[string][]uuid.UUID{"user_id": users, "group_id": groups} {
			if _, err := tx.Exec(ctx, `INSERT INTO chat_channel_access (tenant_id, channel_id, `+col+`)
				SELECT $1, $2, x FROM unnest($3::uuid[]) AS x ON CONFLICT DO NOTHING`, tenant, channel, ids); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil && !errors.Is(err, ErrOutsideTeam) {
		return fmt.Errorf("teams: set access: %w", err)
	}
	return err
}
