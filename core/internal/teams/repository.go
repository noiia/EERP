package teams

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"

	"core/orm"

	"github.com/google/uuid"
)

// ErrInvalidName is returned for a name that is empty or over 200 chars once trimmed.
var ErrInvalidName = errors.New("teams: name must be 1-200 characters")

// Repository is the tenant-pinned Teams store: every query filters on tenant.
type Repository struct {
	db       *orm.DB
	teams    *orm.Repository[Team]
	members  *orm.Repository[Member]
	channels *orm.Repository[Channel]
}

func NewRepository(db *orm.DB) *Repository {
	return &Repository{
		db:       db,
		teams:    orm.MustRepo[Team](db),
		members:  orm.MustRepo[Member](db),
		channels: orm.MustRepo[Channel](db),
	}
}

// CreateTeam inserts the team, its owner membership and a "general" channel in one transaction.
func (r *Repository) CreateTeam(ctx context.Context, t Team, owner uuid.UUID) (Team, Channel, error) {
	t.Name = strings.TrimSpace(t.Name)
	if n := len([]rune(t.Name)); n < 1 || n > 200 {
		return Team{}, Channel{}, ErrInvalidName
	}
	var ch Channel
	err := orm.Transact(ctx, r.db, func(tx *orm.Tx) error {
		var err error
		if t, err = r.teams.WithTx(tx).Create(ctx, t); err != nil {
			return err
		}
		if _, err = r.members.WithTx(tx).Create(ctx,
			Member{TenantID: t.TenantID, TeamID: t.ID, UserID: owner, Role: RoleOwner}); err != nil {
			return err
		}
		ch, err = r.channels.WithTx(tx).Create(ctx,
			Channel{TenantID: t.TenantID, TeamID: &t.ID, Kind: KindChannel, Name: "general"})
		return err
	})
	if err != nil {
		return Team{}, Channel{}, fmt.Errorf("teams: create team: %w", err)
	}
	return t, ch, nil
}

// RoleOf returns the user's role in the team, orm.ErrNotFound when not a member.
func (r *Repository) RoleOf(ctx context.Context, tenant, team, user uuid.UUID) (string, error) {
	rows, err := r.members.FindAll(ctx,
		orm.Cond("tenant_id = $1", tenant), orm.Cond("team_id = $2", team), orm.Cond("user_id = $3", user))
	if err != nil {
		return "", fmt.Errorf("teams: role of: %w", err)
	}
	if len(rows) == 0 {
		return "", orm.ErrNotFound
	}
	return rows[0].Role, nil
}

type TeamSummary struct {
	Team
	Role        string
	MemberCount int
	Unread      int // filled by the chat task
}

// ListMyTeams returns the teams the user belongs to, by name.
func (r *Repository) ListMyTeams(ctx context.Context, tenant, user uuid.UUID) ([]TeamSummary, error) {
	mine, err := r.members.FindAll(ctx, orm.Cond("tenant_id = $1", tenant), orm.Cond("user_id = $2", user))
	if err != nil {
		return nil, fmt.Errorf("teams: list mine: %w", err)
	}
	if len(mine) == 0 {
		return []TeamSummary{}, nil
	}
	ids := make([]uuid.UUID, len(mine))
	roles := make(map[uuid.UUID]string, len(mine))
	for i, m := range mine {
		ids[i], roles[m.TeamID] = m.TeamID, m.Role
	}
	teams, err := r.teams.FindAll(ctx, orm.Cond("tenant_id = $1", tenant), orm.In("id", ids))
	if err != nil {
		return nil, fmt.Errorf("teams: list mine: %w", err)
	}
	all, err := r.members.FindAll(ctx, orm.Cond("tenant_id = $1", tenant), orm.In("team_id", ids))
	if err != nil {
		return nil, fmt.Errorf("teams: count members: %w", err)
	}
	counts := map[uuid.UUID]int{}
	for _, m := range all {
		counts[m.TeamID]++
	}
	out := make([]TeamSummary, len(teams))
	for i, t := range teams {
		out[i] = TeamSummary{Team: t, Role: roles[t.ID], MemberCount: counts[t.ID]}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

var (
	ErrLastOwner   = errors.New("teams: a team needs at least one owner")
	ErrLastChannel = errors.New("teams: a team needs at least one channel")
	ErrExists      = errors.New("teams: already a member")
)

func (r *Repository) GetTeam(ctx context.Context, tenant, id uuid.UUID) (Team, error) {
	rows, err := r.teams.FindAll(ctx, orm.Cond("tenant_id = $1", tenant), orm.Cond("id = $2", id))
	if err != nil {
		return Team{}, fmt.Errorf("teams: get: %w", err)
	}
	if len(rows) == 0 {
		return Team{}, orm.ErrNotFound
	}
	return rows[0], nil
}

func validName(s string) (string, error) {
	s = strings.TrimSpace(s)
	if n := len([]rune(s)); n < 1 || n > 200 {
		return "", ErrInvalidName
	}
	return s, nil
}

func (r *Repository) UpdateTeam(ctx context.Context, tenant, id uuid.UUID, name, description string) (Team, error) {
	name, err := validName(name)
	if err != nil {
		return Team{}, err
	}
	t, err := r.GetTeam(ctx, tenant, id)
	if err != nil {
		return Team{}, err
	}
	t.Name, t.Description = name, description
	return r.teams.Update(ctx, t, id)
}

// DeleteTeam hard-deletes every row of the team in one transaction and returns
// the object keys (team files and chat attachments) the caller must remove from storage.
func (r *Repository) DeleteTeam(ctx context.Context, tenant, team uuid.UUID) ([]string, error) {
	var keys []string
	err := orm.Transact(ctx, r.db, func(tx *orm.Tx) error {
		rows, err := tx.Query(ctx, `SELECT object_key FROM team_file WHERE tenant_id=$1 AND team_id=$2
			UNION ALL SELECT a.object_key FROM chat_attachment a JOIN chat_message m ON m.id=a.message_id
			JOIN chat_channel c ON c.id=m.channel_id WHERE c.tenant_id=$1 AND c.team_id=$2`, tenant, team)
		if err != nil {
			return err
		}
		for rows.Next() {
			var k string
			if err := rows.Scan(&k); err != nil {
				rows.Close()
				return err
			}
			keys = append(keys, k)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		chans := `(SELECT id FROM chat_channel WHERE tenant_id=$1 AND team_id=$2)`
		msgs := `(SELECT id FROM chat_message WHERE channel_id IN ` + chans + `)`
		for _, q := range []string{
			`DELETE FROM team_file_share WHERE file_id IN (SELECT id FROM team_file WHERE tenant_id=$1 AND team_id=$2)`,
			`DELETE FROM chat_reaction WHERE message_id IN ` + msgs,
			`DELETE FROM chat_attachment WHERE message_id IN ` + msgs,
			`DELETE FROM chat_message WHERE channel_id IN ` + chans,
			`DELETE FROM chat_channel_member WHERE channel_id IN ` + chans,
			`DELETE FROM chat_channel WHERE tenant_id=$1 AND team_id=$2`,
			`DELETE FROM team_file WHERE tenant_id=$1 AND team_id=$2`,
			`DELETE FROM team_folder WHERE tenant_id=$1 AND team_id=$2`,
			`DELETE FROM team_member WHERE tenant_id=$1 AND team_id=$2`,
			`DELETE FROM team WHERE tenant_id=$1 AND id=$2`,
		} {
			if _, err := tx.Exec(ctx, q, tenant, team); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("teams: delete team: %w", err)
	}
	return keys, nil
}

func (r *Repository) ListMembers(ctx context.Context, tenant, team uuid.UUID) ([]Member, error) {
	return r.members.FindAll(ctx, orm.Cond("tenant_id = $1", tenant), orm.Cond("team_id = $2", team))
}

func (r *Repository) AddMember(ctx context.Context, tenant, team, user uuid.UUID, role string) (Member, error) {
	if _, err := r.RoleOf(ctx, tenant, team, user); err == nil {
		return Member{}, ErrExists
	}
	return r.members.Create(ctx, Member{TenantID: tenant, TeamID: team, UserID: user, Role: role})
}

// changeMember changes (or, with newRole "", removes) a member inside a transaction that holds
// the team row lock, so two concurrent demotions can't both pass the last-owner check.
func (r *Repository) changeMember(ctx context.Context, tenant, team, user uuid.UUID, newRole string) error {
	return orm.Transact(ctx, r.db, func(tx *orm.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT 1 FROM team WHERE id=$1 FOR UPDATE`, team); err != nil {
			return err
		}
		ms := r.members.WithTx(tx)
		rows, err := ms.FindAll(ctx, orm.Cond("tenant_id = $1", tenant), orm.Cond("team_id = $2", team))
		if err != nil {
			return err
		}
		var target *Member
		owners := 0
		for i, m := range rows {
			if m.Role == RoleOwner {
				owners++
			}
			if m.UserID == user {
				target = &rows[i]
			}
		}
		if target == nil {
			return orm.ErrNotFound
		}
		if target.Role == RoleOwner && newRole != RoleOwner && owners == 1 {
			return ErrLastOwner
		}
		if newRole == "" {
			_, err = ms.Delete(ctx, target.ID)
			return err
		}
		target.Role = newRole
		_, err = ms.Update(ctx, *target, target.ID)
		return err
	})
}

func (r *Repository) SetRole(ctx context.Context, tenant, team, user uuid.UUID, role string) error {
	return r.changeMember(ctx, tenant, team, user, role)
}

func (r *Repository) RemoveMember(ctx context.Context, tenant, team, user uuid.UUID) error {
	return r.changeMember(ctx, tenant, team, user, "")
}

func (r *Repository) ListChannels(ctx context.Context, tenant, team uuid.UUID) ([]Channel, error) {
	rows, err := r.channels.FindAll(ctx, orm.Cond("tenant_id = $1", tenant), orm.Cond("team_id = $2", team),
		orm.Cond("kind = $3", KindChannel))
	if err != nil {
		return nil, fmt.Errorf("teams: list channels: %w", err)
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].Name < rows[j].Name })
	return rows, nil
}

func (r *Repository) CreateChannel(ctx context.Context, tenant, team uuid.UUID, name string) (Channel, error) {
	name, err := validName(name)
	if err != nil {
		return Channel{}, err
	}
	return r.channels.Create(ctx, Channel{TenantID: tenant, TeamID: &team, Kind: KindChannel, Name: name})
}

func (r *Repository) findChannel(ctx context.Context, tenant, team, id uuid.UUID) (Channel, error) {
	rows, err := r.channels.FindAll(ctx, orm.Cond("tenant_id = $1", tenant), orm.Cond("team_id = $2", team),
		orm.Cond("id = $3", id), orm.Cond("kind = $4", KindChannel))
	if err != nil {
		return Channel{}, err
	}
	if len(rows) == 0 {
		return Channel{}, orm.ErrNotFound
	}
	return rows[0], nil
}

func (r *Repository) RenameChannel(ctx context.Context, tenant, team, id uuid.UUID, name string) (Channel, error) {
	name, err := validName(name)
	if err != nil {
		return Channel{}, err
	}
	ch, err := r.findChannel(ctx, tenant, team, id)
	if err != nil {
		return Channel{}, err
	}
	ch.Name = name
	return r.channels.Update(ctx, ch, id)
}

func (r *Repository) DeleteChannel(ctx context.Context, tenant, team, id uuid.UUID) error {
	if _, err := r.findChannel(ctx, tenant, team, id); err != nil {
		return err
	}
	all, err := r.ListChannels(ctx, tenant, team)
	if err != nil {
		return err
	}
	if len(all) <= 1 {
		return ErrLastChannel
	}
	_, err = r.channels.Delete(ctx, id)
	return err
}
