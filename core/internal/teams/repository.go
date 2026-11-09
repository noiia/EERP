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
			Channel{TenantID: t.TenantID, TeamID: &t.ID, Kind: "channel", Name: "general"})
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
