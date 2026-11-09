package teams

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"core/orm"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// ErrInvalidName is returned for a name that is empty or over 200 chars once trimmed.
var ErrInvalidName = errors.New("teams: name must be 1-200 characters")

// Repository is the tenant-pinned Teams store: every query filters on tenant.
type Repository struct {
	db       *orm.DB
	teams    *orm.Repository[Team]
	members  *orm.Repository[Member]
	channels *orm.Repository[Channel]
	cursors  *orm.Repository[ChannelMember]
	messages *orm.Repository[Message]
	atts     *orm.Repository[Attachment]
	folders  *orm.Repository[Folder]
	files    *orm.Repository[File]
}

func NewRepository(db *orm.DB) *Repository {
	return &Repository{
		db:       db,
		teams:    orm.MustRepo[Team](db),
		members:  orm.MustRepo[Member](db),
		channels: orm.MustRepo[Channel](db),
		cursors:  orm.MustRepo[ChannelMember](db),
		messages: orm.MustRepo[Message](db),
		atts:     orm.MustRepo[Attachment](db),
		folders:  orm.MustRepo[Folder](db),
		files:    orm.MustRepo[File](db),
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
		orm.Cond("tenant_id = $1", tenant), orm.Cond("team_id = $1", team), orm.Cond("user_id = $1", user))
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
	Unread      int // sum over the team's channels
}

// ListMyTeams returns the teams the user belongs to, by name.
func (r *Repository) ListMyTeams(ctx context.Context, tenant, user uuid.UUID) ([]TeamSummary, error) {
	mine, err := r.members.FindAll(ctx, orm.Cond("tenant_id = $1", tenant), orm.Cond("user_id = $1", user))
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
	// Only the channels the user can see count (the visibility rule, across all their teams at once).
	rows, err := r.db.Query(ctx, `SELECT c.id, c.team_id FROM chat_channel c
		JOIN team_member m ON m.team_id = c.team_id AND m.user_id = $2 AND m.tenant_id = $1 AND m.deleted_at IS NULL
		WHERE c.tenant_id = $1 AND c.kind = 'channel' AND c.deleted_at IS NULL AND (m.role = 'owner' OR `+sees("$2")+`)`, tenant, user)
	if err != nil {
		return nil, fmt.Errorf("teams: list channels: %w", err)
	}
	chans, err := pgx.CollectRows(rows, pgx.RowToStructByPos[struct{ ID, TeamID uuid.UUID }])
	if err != nil {
		return nil, fmt.Errorf("teams: list channels: %w", err)
	}
	chIDs := make([]uuid.UUID, len(chans))
	for i, ch := range chans {
		chIDs[i] = ch.ID
	}
	unread, err := r.UnreadCounts(ctx, tenant, user, chIDs)
	if err != nil {
		return nil, err
	}
	perTeam := map[uuid.UUID]int{}
	for _, ch := range chans {
		perTeam[ch.TeamID] += unread[ch.ID]
	}
	out := make([]TeamSummary, len(teams))
	for i, t := range teams {
		out[i] = TeamSummary{Team: t, Role: roles[t.ID], MemberCount: counts[t.ID], Unread: perTeam[t.ID]}
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
	rows, err := r.teams.FindAll(ctx, orm.Cond("tenant_id = $1", tenant), orm.Cond("id = $1", id))
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
			`DELETE FROM chat_channel_access WHERE channel_id IN ` + chans,
			`DELETE FROM chat_channel WHERE tenant_id=$1 AND team_id=$2`,
			`DELETE FROM team_group_member WHERE group_id IN (SELECT id FROM team_group WHERE tenant_id=$1 AND team_id=$2)`,
			`DELETE FROM team_group WHERE tenant_id=$1 AND team_id=$2`,
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
	return r.members.FindAll(ctx, orm.Cond("tenant_id = $1", tenant), orm.Cond("team_id = $1", team))
}

func (r *Repository) AddMember(ctx context.Context, tenant, team, user uuid.UUID, role string) (Member, error) {
	// uq_team_member decides, so two concurrent adds can't both succeed or 500.
	m, err := r.members.Create(ctx, Member{TenantID: tenant, TeamID: team, UserID: user, Role: role})
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return Member{}, ErrExists
	}
	return m, err
}

// changeMember changes (or, with newRole "", removes) a member inside a transaction that holds
// the team row lock, so two concurrent demotions can't both pass the last-owner check.
func (r *Repository) changeMember(ctx context.Context, tenant, team, user uuid.UUID, newRole string) error {
	return orm.Transact(ctx, r.db, func(tx *orm.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT 1 FROM team WHERE id=$1 FOR UPDATE`, team); err != nil {
			return err
		}
		ms := r.members.WithTx(tx)
		rows, err := ms.FindAll(ctx, orm.Cond("tenant_id = $1", tenant), orm.Cond("team_id = $1", team))
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
			if _, err = ms.Delete(ctx, target.ID); err != nil {
				return err
			}
			// A former member leaves the team's groups and channel access lists with it.
			for _, q := range []string{
				`DELETE FROM team_group_member WHERE tenant_id=$1 AND user_id=$3
					AND group_id IN (SELECT id FROM team_group WHERE tenant_id=$1 AND team_id=$2)`,
				`DELETE FROM chat_channel_access WHERE tenant_id=$1 AND user_id=$3
					AND channel_id IN (SELECT id FROM chat_channel WHERE tenant_id=$1 AND team_id=$2)`,
			} {
				if _, err := tx.Exec(ctx, q, tenant, team, user); err != nil {
					return err
				}
			}
			return nil
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
	rows, err := r.channels.FindAll(ctx, orm.Cond("tenant_id = $1", tenant), orm.Cond("team_id = $1", team),
		orm.Cond("kind = $1", KindChannel))
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
	rows, err := r.channels.FindAll(ctx, orm.Cond("tenant_id = $1", tenant), orm.Cond("team_id = $1", team),
		orm.Cond("id = $1", id), orm.Cond("kind = $1", KindChannel))
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

// DeleteChannel removes the channel with its messages, attachments, reactions
// and read cursors in one transaction, returning the attachment object keys
// the caller must remove from storage.
func (r *Repository) DeleteChannel(ctx context.Context, tenant, team, id uuid.UUID) ([]string, error) {
	if _, err := r.findChannel(ctx, tenant, team, id); err != nil {
		return nil, err
	}
	var keys []string
	err := orm.Transact(ctx, r.db, func(tx *orm.Tx) error {
		// The team row lock serializes concurrent deletes, so two can't both pass the last-channel check.
		if _, err := tx.Exec(ctx, `SELECT 1 FROM team WHERE id=$1 AND tenant_id=$2 FOR UPDATE`, team, tenant); err != nil {
			return err
		}
		var n int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM chat_channel WHERE tenant_id=$1 AND team_id=$2 AND kind='channel'
			AND deleted_at IS NULL`, tenant, team).Scan(&n); err != nil {
			return err
		}
		if n <= 1 {
			return ErrLastChannel
		}
		rows, err := tx.Query(ctx, `SELECT a.object_key FROM chat_attachment a JOIN chat_message m ON m.id=a.message_id
			WHERE m.tenant_id=$1 AND m.channel_id=$2`, tenant, id)
		if err != nil {
			return err
		}
		if keys, err = pgx.CollectRows(rows, pgx.RowTo[string]); err != nil {
			return err
		}
		msgs := `(SELECT id FROM chat_message WHERE tenant_id=$1 AND channel_id=$2)`
		for _, q := range []string{
			`DELETE FROM chat_reaction WHERE message_id IN ` + msgs,
			`DELETE FROM chat_attachment WHERE message_id IN ` + msgs,
			`DELETE FROM chat_message WHERE tenant_id=$1 AND channel_id=$2`,
			`DELETE FROM chat_channel_member WHERE tenant_id=$1 AND channel_id=$2`,
			`DELETE FROM chat_channel_access WHERE tenant_id=$1 AND channel_id=$2`,
			`DELETE FROM chat_channel WHERE tenant_id=$1 AND id=$2`,
		} {
			if _, err := tx.Exec(ctx, q, tenant, id); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("teams: delete channel: %w", err)
	}
	return keys, nil
}

// FindChannel returns any live channel of the tenant, team or direct.
func (r *Repository) FindChannel(ctx context.Context, tenant, id uuid.UUID) (Channel, error) {
	rows, err := r.channels.FindAll(ctx, orm.Cond("tenant_id = $1", tenant), orm.Cond("id = $1", id))
	if err != nil {
		return Channel{}, fmt.Errorf("teams: find channel: %w", err)
	}
	if len(rows) == 0 {
		return Channel{}, orm.ErrNotFound
	}
	return rows[0], nil
}

// GetOrCreateDirect returns the a/b conversation, creating it (and both
// participants' cursor rows) when missing. The unique direct_key index decides
// a concurrent race: the loser re-reads the winner's row.
func (r *Repository) GetOrCreateDirect(ctx context.Context, tenant, a, b uuid.UUID) (Channel, error) {
	key := DirectKey(a, b)
	find := func() ([]Channel, error) {
		return r.channels.FindAll(ctx, orm.Cond("tenant_id = $1", tenant), orm.Cond("kind = $1", KindDirect),
			orm.Cond("direct_key = $1", key))
	}
	if rows, err := find(); err != nil || len(rows) > 0 {
		if err != nil {
			return Channel{}, fmt.Errorf("teams: find direct: %w", err)
		}
		return rows[0], nil
	}
	var ch Channel
	err := orm.Transact(ctx, r.db, func(tx *orm.Tx) error {
		var err error
		if ch, err = r.channels.WithTx(tx).Create(ctx, Channel{TenantID: tenant, Kind: KindDirect, DirectKey: key}); err != nil {
			return err
		}
		for _, u := range []uuid.UUID{a, b} {
			if _, err := r.cursors.WithTx(tx).Create(ctx, ChannelMember{TenantID: tenant, ChannelID: ch.ID, UserID: u}); err != nil {
				return err
			}
		}
		return nil
	})
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		rows, err := find()
		if err != nil || len(rows) == 0 {
			return Channel{}, fmt.Errorf("teams: re-read direct: %w", err)
		}
		return rows[0], nil
	}
	if err != nil {
		return Channel{}, fmt.Errorf("teams: create direct: %w", err)
	}
	return ch, nil
}

type DirectSummary struct {
	Channel       Channel
	LastMessageAt *time.Time
}

// ListDirect returns the user's direct conversations, own order first, then most recent activity.
func (r *Repository) ListDirect(ctx context.Context, tenant, user uuid.UUID) ([]DirectSummary, error) {
	rows, err := r.db.Query(ctx, `SELECT c.id, c.direct_key, (SELECT max(m.created_at) FROM chat_message m
			WHERE m.channel_id = c.id AND m.deleted_at IS NULL)
		FROM chat_channel c JOIN chat_channel_member cm ON cm.channel_id = c.id AND cm.user_id = $2 AND cm.deleted_at IS NULL
		WHERE c.tenant_id = $1 AND c.kind = 'direct' AND c.deleted_at IS NULL
		ORDER BY cm.position ASC NULLS LAST, 3 DESC NULLS LAST, c.id`, tenant, user)
	if err != nil {
		return nil, fmt.Errorf("teams: list direct: %w", err)
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (DirectSummary, error) {
		d := DirectSummary{Channel: Channel{TenantID: tenant, Kind: KindDirect}}
		err := row.Scan(&d.Channel.ID, &d.Channel.DirectKey, &d.LastMessageAt)
		return d, err
	})
}

// ListChannelsFor is ListChannels in the user's own order: position ASC NULLS LAST, then name.
func (r *Repository) ListChannelsFor(ctx context.Context, tenant, team, user uuid.UUID) ([]Channel, error) {
	rows, err := r.ListChannels(ctx, tenant, team)
	if err != nil || len(rows) == 0 {
		return rows, err
	}
	ids := make([]uuid.UUID, len(rows))
	for i, ch := range rows {
		ids[i] = ch.ID
	}
	cms, err := r.cursors.FindAll(ctx, orm.Cond("tenant_id = $1", tenant), orm.Cond("user_id = $1", user), orm.In("channel_id", ids))
	if err != nil {
		return nil, fmt.Errorf("teams: channel positions: %w", err)
	}
	pos := make(map[uuid.UUID]int, len(cms))
	for _, cm := range cms {
		if cm.Position != nil {
			pos[cm.ChannelID] = *cm.Position
		}
	}
	sort.SliceStable(rows, func(i, j int) bool {
		pi, oi := pos[rows[i].ID]
		pj, oj := pos[rows[j].ID]
		if oi != oj {
			return oi
		}
		return oi && pi < pj
	})
	return rows, nil
}

// SetOrder stores the user's own position (the index) of each channel, in one transaction.
func (r *Repository) SetOrder(ctx context.Context, tenant, user uuid.UUID, channels []uuid.UUID) error {
	return orm.Transact(ctx, r.db, func(tx *orm.Tx) error {
		for i, ch := range channels {
			p := i
			if _, err := r.cursors.WithTx(tx).UpsertPartial(ctx, ChannelMember{TenantID: tenant, ChannelID: ch, UserID: user, Position: &p},
				[]string{"channel_id", "user_id"}, "deleted_at IS NULL", "position = EXCLUDED.position, updated_at = now()"); err != nil {
				return fmt.Errorf("teams: set order: %w", err)
			}
		}
		return nil
	})
}

// UnreadCounts counts, per channel, the messages by others newer than the user's read cursor.
func (r *Repository) UnreadCounts(ctx context.Context, tenant, user uuid.UUID, channels []uuid.UUID) (map[uuid.UUID]int, error) {
	out := make(map[uuid.UUID]int, len(channels))
	if len(channels) == 0 {
		return out, nil
	}
	rows, err := r.db.Query(ctx, `SELECT m.channel_id,
			count(*) FILTER (WHERE m.author_id <> $2 AND (cm.last_read_at IS NULL OR m.created_at > cm.last_read_at))
		FROM chat_message m
		LEFT JOIN chat_channel_member cm ON cm.channel_id = m.channel_id AND cm.user_id = $2 AND cm.deleted_at IS NULL
		WHERE m.tenant_id = $1 AND m.channel_id = ANY($3) AND m.deleted_at IS NULL
		GROUP BY m.channel_id`, tenant, user, channels)
	if err != nil {
		return nil, fmt.Errorf("teams: unread: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id uuid.UUID
		var n int
		if err := rows.Scan(&id, &n); err != nil {
			return nil, fmt.Errorf("teams: unread: %w", err)
		}
		out[id] = n
	}
	return out, rows.Err()
}

// MarkRead moves the user's read cursor on the channel to now.
func (r *Repository) MarkRead(ctx context.Context, tenant, channel, user uuid.UUID) error {
	now := time.Now()
	_, err := r.cursors.UpsertPartial(ctx, ChannelMember{TenantID: tenant, ChannelID: channel, UserID: user, LastReadAt: &now},
		[]string{"channel_id", "user_id"}, "deleted_at IS NULL", "last_read_at = EXCLUDED.last_read_at, updated_at = now()")
	if err != nil {
		return fmt.Errorf("teams: mark read: %w", err)
	}
	return nil
}

// CreateMessage inserts the message and its attachments in one transaction.
func (r *Repository) CreateMessage(ctx context.Context, m Message, atts []Attachment) (Message, []Attachment, error) {
	err := orm.Transact(ctx, r.db, func(tx *orm.Tx) error {
		var err error
		if m, err = r.messages.WithTx(tx).Create(ctx, m); err != nil {
			return err
		}
		for i := range atts {
			atts[i].TenantID, atts[i].MessageID = m.TenantID, m.ID
			if atts[i], err = r.atts.WithTx(tx).Create(ctx, atts[i]); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return Message{}, nil, fmt.Errorf("teams: create message: %w", err)
	}
	return m, atts, nil
}

// ListMessages returns up to limit messages of the channel older than before (when set), newest first.
func (r *Repository) ListMessages(ctx context.Context, tenant, channel uuid.UUID, before *time.Time, limit int) ([]Message, error) {
	q := orm.Select[Message](r.messages.Meta()).Where(orm.Cond("tenant_id = $1", tenant)).
		Where(orm.Cond("channel_id = $1", channel)).Where(orm.Cond("deleted_at IS NULL"))
	if before != nil {
		q = q.Where(orm.Cond("created_at < $1", *before))
	}
	rows, err := q.OrderBy("created_at DESC, id DESC").Limit(limit).All(ctx, r.db)
	if err != nil {
		return nil, fmt.Errorf("teams: list messages: %w", err)
	}
	return rows, nil
}

func (r *Repository) FindMessage(ctx context.Context, tenant, id uuid.UUID) (Message, error) {
	rows, err := r.messages.FindAll(ctx, orm.Cond("tenant_id = $1", tenant), orm.Cond("id = $1", id))
	if err != nil {
		return Message{}, fmt.Errorf("teams: find message: %w", err)
	}
	if len(rows) == 0 {
		return Message{}, orm.ErrNotFound
	}
	return rows[0], nil
}

func (r *Repository) FindAttachment(ctx context.Context, tenant, id uuid.UUID) (Attachment, error) {
	rows, err := r.atts.FindAll(ctx, orm.Cond("tenant_id = $1", tenant), orm.Cond("id = $1", id))
	if err != nil {
		return Attachment{}, fmt.Errorf("teams: find attachment: %w", err)
	}
	if len(rows) == 0 {
		return Attachment{}, orm.ErrNotFound
	}
	return rows[0], nil
}

// AttachmentsOf groups the messages' attachments by message id.
func (r *Repository) AttachmentsOf(ctx context.Context, tenant uuid.UUID, messages []uuid.UUID) (map[uuid.UUID][]Attachment, error) {
	out := map[uuid.UUID][]Attachment{}
	if len(messages) == 0 {
		return out, nil
	}
	rows, err := r.atts.FindAll(ctx, orm.Cond("tenant_id = $1", tenant), orm.In("message_id", messages))
	if err != nil {
		return nil, fmt.Errorf("teams: attachments: %w", err)
	}
	for _, a := range rows {
		out[a.MessageID] = append(out[a.MessageID], a)
	}
	return out, nil
}

type ReactionCount struct {
	Emoji string
	Count int
	Mine  bool
}

// ReactionsOf groups the messages' reaction counts by message id, Mine for user's own.
func (r *Repository) ReactionsOf(ctx context.Context, tenant, user uuid.UUID, messages []uuid.UUID) (map[uuid.UUID][]ReactionCount, error) {
	out := map[uuid.UUID][]ReactionCount{}
	if len(messages) == 0 {
		return out, nil
	}
	rows, err := r.db.Query(ctx, `SELECT message_id, emoji, count(*), bool_or(user_id = $2)
		FROM chat_reaction WHERE tenant_id = $1 AND message_id = ANY($3) AND deleted_at IS NULL
		GROUP BY message_id, emoji ORDER BY min(created_at), emoji`, tenant, user, messages)
	if err != nil {
		return nil, fmt.Errorf("teams: reactions: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id uuid.UUID
		var rc ReactionCount
		if err := rows.Scan(&id, &rc.Emoji, &rc.Count, &rc.Mine); err != nil {
			return nil, fmt.Errorf("teams: reactions: %w", err)
		}
		out[id] = append(out[id], rc)
	}
	return out, rows.Err()
}

// ToggleReaction removes the user's emoji on the message, or adds it when absent.
func (r *Repository) ToggleReaction(ctx context.Context, tenant, message, user uuid.UUID, emoji string) error {
	return orm.Transact(ctx, r.db, func(tx *orm.Tx) error {
		tag, err := tx.Exec(ctx, `DELETE FROM chat_reaction WHERE tenant_id=$1 AND message_id=$2 AND user_id=$3 AND emoji=$4`,
			tenant, message, user, emoji)
		if err != nil || tag.RowsAffected() > 0 {
			return err
		}
		_, err = tx.Exec(ctx, `INSERT INTO chat_reaction (tenant_id, message_id, user_id, emoji) VALUES ($1,$2,$3,$4)
			ON CONFLICT (message_id, user_id, emoji) WHERE deleted_at IS NULL DO NOTHING`, tenant, message, user, emoji)
		return err
	})
}

func first[T any](rows []T, err error) (T, error) {
	var zero T
	if err != nil {
		return zero, err
	}
	if len(rows) == 0 {
		return zero, orm.ErrNotFound
	}
	return rows[0], nil
}

func (r *Repository) FindFolder(ctx context.Context, tenant, id uuid.UUID) (Folder, error) {
	return first(r.folders.FindAll(ctx, orm.Cond("tenant_id = $1", tenant), orm.Cond("id = $1", id)))
}

func (r *Repository) FindFile(ctx context.Context, tenant, id uuid.UUID) (File, error) {
	return first(r.files.FindAll(ctx, orm.Cond("tenant_id = $1", tenant), orm.Cond("id = $1", id)))
}

// ListFolder returns the folders and files directly inside folder (nil = the team root), by name.
func (r *Repository) ListFolder(ctx context.Context, tenant, team uuid.UUID, folder *uuid.UUID) ([]Folder, []File, error) {
	fs, err := r.folders.FindAll(ctx, orm.Cond("tenant_id = $1", tenant), orm.Cond("team_id = $1", team), orm.Cond("parent_id IS NOT DISTINCT FROM $1", folder))
	if err != nil {
		return nil, nil, fmt.Errorf("teams: list folders: %w", err)
	}
	files, err := r.files.FindAll(ctx, orm.Cond("tenant_id = $1", tenant), orm.Cond("team_id = $1", team), orm.Cond("folder_id IS NOT DISTINCT FROM $1", folder))
	if err != nil {
		return nil, nil, fmt.Errorf("teams: list files: %w", err)
	}
	sort.Slice(fs, func(i, j int) bool { return fs[i].Name < fs[j].Name })
	sort.Slice(files, func(i, j int) bool { return files[i].Name < files[j].Name })
	return fs, files, nil
}

// Ancestors returns folder and its parents up to the root, nearest first.
func (r *Repository) Ancestors(ctx context.Context, tenant, folder uuid.UUID) ([]Folder, error) {
	var chain []Folder
	for id := &folder; id != nil && len(chain) < 1000; { // bound: a corrupted cycle can't spin forever
		f, err := r.FindFolder(ctx, tenant, *id)
		if err != nil {
			return nil, err
		}
		chain = append(chain, f)
		id = f.ParentID
	}
	return chain, nil
}

func (r *Repository) CreateFolder(ctx context.Context, f Folder) (Folder, error) {
	var err error
	if f.Name, err = validName(f.Name); err != nil {
		return Folder{}, err
	}
	return r.folders.Create(ctx, f)
}

func (r *Repository) UpdateFolder(ctx context.Context, f Folder) (Folder, error) {
	var err error
	if f.Name, err = validName(f.Name); err != nil {
		return Folder{}, err
	}
	return r.folders.Update(ctx, f, f.ID)
}

func (r *Repository) CreateFile(ctx context.Context, f File) (File, error) {
	var err error
	if f.Name, err = validName(f.Name); err != nil {
		return File{}, err
	}
	return r.files.Create(ctx, f)
}

func (r *Repository) UpdateFile(ctx context.Context, f File) (File, error) {
	var err error
	if f.Name, err = validName(f.Name); err != nil {
		return File{}, err
	}
	return r.files.Update(ctx, f, f.ID)
}

// DeleteFile removes the file and its shares, returning its object key.
func (r *Repository) DeleteFile(ctx context.Context, tenant, id uuid.UUID) (string, error) {
	var key string
	err := orm.Transact(ctx, r.db, func(tx *orm.Tx) error {
		if _, err := tx.Exec(ctx, `DELETE FROM team_file_share WHERE tenant_id=$1 AND file_id=$2`, tenant, id); err != nil {
			return err
		}
		return tx.QueryRow(ctx, `DELETE FROM team_file WHERE tenant_id=$1 AND id=$2 RETURNING object_key`, tenant, id).Scan(&key)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return "", orm.ErrNotFound
	}
	if err != nil {
		return "", fmt.Errorf("teams: delete file: %w", err)
	}
	return key, nil
}

// DeleteFolderTree removes the folder, its subfolders, their files and shares in
// one transaction, returning the files' object keys for the caller to delete.
func (r *Repository) DeleteFolderTree(ctx context.Context, tenant, folder uuid.UUID) ([]string, error) {
	var keys []string
	err := orm.Transact(ctx, r.db, func(tx *orm.Tx) error {
		rows, err := tx.Query(ctx, `WITH RECURSIVE tree AS (
				SELECT id FROM team_folder WHERE tenant_id=$1 AND id=$2
				UNION SELECT f.id FROM team_folder f JOIN tree t ON f.parent_id = t.id WHERE f.tenant_id=$1)
			SELECT id FROM tree`, tenant, folder)
		if err != nil {
			return err
		}
		ids, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
		if err != nil {
			return err
		}
		if len(ids) == 0 {
			return orm.ErrNotFound
		}
		if rows, err = tx.Query(ctx, `SELECT object_key FROM team_file WHERE tenant_id=$1 AND folder_id = ANY($2)`, tenant, ids); err != nil {
			return err
		}
		if keys, err = pgx.CollectRows(rows, pgx.RowTo[string]); err != nil {
			return err
		}
		for _, q := range []string{
			`DELETE FROM team_file_share WHERE file_id IN (SELECT id FROM team_file WHERE tenant_id=$1 AND folder_id = ANY($2))`,
			`DELETE FROM team_file WHERE tenant_id=$1 AND folder_id = ANY($2)`,
			`DELETE FROM team_folder WHERE tenant_id=$1 AND id = ANY($2)`,
		} {
			if _, err := tx.Exec(ctx, q, tenant, ids); err != nil {
				return err
			}
		}
		return nil
	})
	if errors.Is(err, orm.ErrNotFound) {
		return nil, err
	}
	if err != nil {
		return nil, fmt.Errorf("teams: delete folder tree: %w", err)
	}
	return keys, nil
}

// ShareCounts counts the recipients of each file.
func (r *Repository) ShareCounts(ctx context.Context, tenant uuid.UUID, files []uuid.UUID) (map[uuid.UUID]int, error) {
	out := map[uuid.UUID]int{}
	if len(files) == 0 {
		return out, nil
	}
	rows, err := r.db.Query(ctx, `SELECT file_id, count(*) FROM team_file_share
		WHERE tenant_id=$1 AND file_id = ANY($2) AND deleted_at IS NULL GROUP BY file_id`, tenant, files)
	if err != nil {
		return nil, fmt.Errorf("teams: share counts: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id uuid.UUID
		var n int
		if err := rows.Scan(&id, &n); err != nil {
			return nil, fmt.Errorf("teams: share counts: %w", err)
		}
		out[id] = n
	}
	return out, rows.Err()
}

// Recipients returns the users the file is shared with.
func (r *Repository) Recipients(ctx context.Context, tenant, file uuid.UUID) ([]uuid.UUID, error) {
	rows, err := r.db.Query(ctx, `SELECT user_id FROM team_file_share WHERE tenant_id=$1 AND file_id=$2 AND deleted_at IS NULL
		ORDER BY created_at, user_id`, tenant, file)
	if err != nil {
		return nil, fmt.Errorf("teams: recipients: %w", err)
	}
	return pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
}

// SetRecipients replaces the file's whole share list.
func (r *Repository) SetRecipients(ctx context.Context, tenant, file uuid.UUID, users []uuid.UUID) error {
	err := orm.Transact(ctx, r.db, func(tx *orm.Tx) error {
		if _, err := tx.Exec(ctx, `DELETE FROM team_file_share WHERE tenant_id=$1 AND file_id=$2`, tenant, file); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `INSERT INTO team_file_share (tenant_id, file_id, user_id)
			SELECT $1, $2, u FROM unnest($3::uuid[]) AS u ON CONFLICT DO NOTHING`, tenant, file, users)
		return err
	})
	if err != nil {
		return fmt.Errorf("teams: set recipients: %w", err)
	}
	return nil
}

// IsSharedWith reports whether file is shared with user.
func (r *Repository) IsSharedWith(ctx context.Context, tenant, file, user uuid.UUID) (bool, error) {
	var ok bool
	err := r.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM team_file_share
		WHERE tenant_id=$1 AND file_id=$2 AND user_id=$3 AND deleted_at IS NULL)`, tenant, file, user).Scan(&ok)
	if err != nil {
		return false, fmt.Errorf("teams: is shared: %w", err)
	}
	return ok, nil
}

type SharedFile struct {
	File     File
	TeamName string
	SharedAt time.Time
}

// SharedWith lists the files shared with user, most recently shared first.
func (r *Repository) SharedWith(ctx context.Context, tenant, user uuid.UUID) ([]SharedFile, error) {
	rows, err := r.db.Query(ctx, `SELECT f.id, f.team_id, f.name, f.mime, f.size, f.uploaded_by, t.name, s.created_at
		FROM team_file_share s JOIN team_file f ON f.id = s.file_id AND f.deleted_at IS NULL
		JOIN team t ON t.id = f.team_id
		WHERE s.tenant_id=$1 AND s.user_id=$2 AND s.deleted_at IS NULL
		ORDER BY s.created_at DESC, f.id`, tenant, user)
	if err != nil {
		return nil, fmt.Errorf("teams: shared with: %w", err)
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (SharedFile, error) {
		s := SharedFile{File: File{TenantID: tenant}}
		err := row.Scan(&s.File.ID, &s.File.TeamID, &s.File.Name, &s.File.Mime, &s.File.Size, &s.File.UploadedBy, &s.TeamName, &s.SharedAt)
		return s, err
	})
}
