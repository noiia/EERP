// Package teams registers the Teams app's tables. Import via core/modules/all.
package teams

import (
	"context"
	"fmt"

	"core/internal/module"
	"core/internal/teams"
	"core/orm"
)

func init() {
	module.RegisterGoModule(&teamsModule{})
}

type teamsModule struct{}

func (m *teamsModule) Name() string { return "teams" }

// Every table stays off the generic CRUD surface: access goes through the
// tenant- and role-checking handlers in internal/teams.
func (m *teamsModule) Register() error {
	for _, err := range []error{
		orm.Register[teams.Team](orm.WithTableName("team"), orm.WithExcluded()),
		orm.Register[teams.Member](orm.WithTableName("team_member"), orm.WithExcluded()),
		orm.Register[teams.Channel](orm.WithTableName("chat_channel"), orm.WithExcluded()),
		orm.Register[teams.ChannelMember](orm.WithTableName("chat_channel_member"), orm.WithExcluded()),
		orm.Register[teams.Message](orm.WithTableName("chat_message"), orm.WithExcluded()),
		orm.Register[teams.Attachment](orm.WithTableName("chat_attachment"), orm.WithExcluded()),
		orm.Register[teams.Reaction](orm.WithTableName("chat_reaction"), orm.WithExcluded()),
		orm.Register[teams.MessageFile](orm.WithTableName("chat_message_file"), orm.WithExcluded()),
		orm.Register[teams.Folder](orm.WithTableName("team_folder"), orm.WithExcluded()),
		orm.Register[teams.File](orm.WithTableName("team_file"), orm.WithExcluded()),
		orm.Register[teams.Share](orm.WithTableName("team_file_share"), orm.WithExcluded()),
		orm.Register[teams.Group](orm.WithTableName("team_group"), orm.WithExcluded()),
		orm.Register[teams.GroupMember](orm.WithTableName("team_group_member"), orm.WithExcluded()),
		orm.Register[teams.ChannelAccess](orm.WithTableName("chat_channel_access"), orm.WithExcluded()),
	} {
		if err != nil {
			return err
		}
	}
	return nil
}

// Migrate adds the indexes struct tags can't express (unique ones, composites).
func (m *teamsModule) Migrate(ctx context.Context, db *orm.DB) error {
	for _, ddl := range []string{
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_team_member ON team_member (team_id, user_id) WHERE deleted_at IS NULL`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_channel_direct ON chat_channel (tenant_id, direct_key) WHERE kind = 'direct' AND deleted_at IS NULL`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_channel_member ON chat_channel_member (channel_id, user_id) WHERE deleted_at IS NULL`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_reaction ON chat_reaction (message_id, user_id, emoji) WHERE deleted_at IS NULL`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_team_file_share ON team_file_share (file_id, user_id) WHERE deleted_at IS NULL`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_team_group_name ON team_group (team_id, lower(name)) WHERE deleted_at IS NULL`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_team_group_member ON team_group_member (group_id, user_id) WHERE deleted_at IS NULL`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_channel_access_user ON chat_channel_access (channel_id, user_id) WHERE user_id IS NOT NULL AND deleted_at IS NULL`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_channel_access_group ON chat_channel_access (channel_id, group_id) WHERE group_id IS NOT NULL AND deleted_at IS NULL`,
		`CREATE INDEX IF NOT EXISTS idx_team_group_member_user ON team_group_member (user_id)`,
		`ALTER TABLE chat_channel ADD COLUMN IF NOT EXISTS restricted boolean`,
		notNullFalse("chat_channel", "restricted"),
		// owners_only: the folder lost its private conversation; only team owners see it until relinked.
		`ALTER TABLE team_folder ADD COLUMN IF NOT EXISTS owners_only boolean`,
		notNullFalse("team_folder", "owners_only"),
		`DO $$ BEGIN
			IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_chat_channel_access_one') THEN
				ALTER TABLE chat_channel_access ADD CONSTRAINT ck_chat_channel_access_one CHECK ((user_id IS NULL) <> (group_id IS NULL));
			END IF;
		END $$`,
		`ALTER TABLE chat_channel ADD COLUMN IF NOT EXISTS folder_id uuid`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_channel_folder ON chat_channel (folder_id) WHERE folder_id IS NOT NULL AND deleted_at IS NULL`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_message_file ON chat_message_file (message_id, file_id)`,
		`CREATE INDEX IF NOT EXISTS idx_chat_message_channel_created ON chat_message (channel_id, created_at)`,
		`CREATE INDEX IF NOT EXISTS idx_team_file_team_folder ON team_file (team_id, folder_id)`,
		`ALTER TABLE chat_channel_member ADD COLUMN IF NOT EXISTS muted boolean`,
		notNullFalse("chat_channel_member", "muted"),
		`ALTER TABLE chat_channel_member ADD COLUMN IF NOT EXISTS hidden boolean`,
		notNullFalse("chat_channel_member", "hidden"),
		`ALTER TABLE chat_channel_member ADD COLUMN IF NOT EXISTS cleared_at timestamptz`,
		uniqueNames("team_folder", "parent_id", "uq_team_folder_name", false),
		uniqueNames("team_file", "folder_id", "uq_team_file_name", true),
	} {
		if _, err := db.Exec(ctx, ddl); err != nil {
			return fmt.Errorf("teams: migrate: %w", err)
		}
	}
	return nil
}

// uniqueNames makes names unique per folder (case ignored) among table's live rows,
// once: rows created before it that clash keep the oldest name, the others get
// " (<id prefix>)" — before the extension for files — so the index can be built.
func uniqueNames(table, parent, index string, keepExt bool) string {
	suffix := `' (' || left(t.id::text, 8) || ')'`
	renamed := `t.name || ` + suffix
	if keepExt {
		renamed = `CASE WHEN t.name ~ '.\.[^.]*$' THEN regexp_replace(t.name, '^(.*)(\.[^.]*)$', '\1') || ` + suffix +
			` || regexp_replace(t.name, '^(.*)(\.[^.]*)$', '\2') ELSE ` + renamed + ` END`
	}
	return `DO $$ BEGIN
		IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = '` + index + `') THEN
			UPDATE ` + table + ` t SET name = ` + renamed + `, updated_at = now()
			FROM (SELECT id, row_number() OVER (PARTITION BY tenant_id, team_id, ` + parent + `, lower(name) ORDER BY created_at, id) AS n
				FROM ` + table + ` WHERE deleted_at IS NULL) d
			WHERE t.id = d.id AND d.n > 1;
			CREATE UNIQUE INDEX ` + index + ` ON ` + table + ` (tenant_id, team_id,
				COALESCE(` + parent + `, '00000000-0000-0000-0000-000000000000'::uuid), lower(name)) WHERE deleted_at IS NULL;
		END IF;
	END $$`
}

// notNullFalse makes a boolean column NOT NULL DEFAULT false, only when it isn't
// yet: the ALTER takes an ACCESS EXCLUSIVE lock, not worth taking on every boot.
func notNullFalse(table, column string) string {
	return `DO $$ BEGIN
		IF EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = '` + table + `'::regclass AND a.attname = '` + column + `'
			AND (NOT a.attnotnull OR NOT a.atthasdef)) THEN
			UPDATE ` + table + ` SET ` + column + ` = false WHERE ` + column + ` IS NULL;
			ALTER TABLE ` + table + ` ALTER COLUMN ` + column + ` SET DEFAULT false, ALTER COLUMN ` + column + ` SET NOT NULL;
		END IF;
	END $$`
}
