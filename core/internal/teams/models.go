// Package teams owns the Teams app: teams with roles, chat channels and a
// shared file space. Every table is tenant-pinned and kept off the generic
// CRUD surface — the dedicated handlers are the only HTTP path to them.
package teams

import (
	"time"

	"core/orm/model"

	"github.com/google/uuid"
)

const (
	KindChannel = "channel"
	KindDirect  = "direct"
)

type Team struct {
	model.BaseModel
	TenantID    uuid.UUID `db:"tenant_id,index"`
	Name        string    `db:"name"`
	Description string    `db:"description"`
}

type Member struct {
	model.BaseModel
	TenantID uuid.UUID `db:"tenant_id,index"`
	TeamID   uuid.UUID `db:"team_id,index"`
	UserID   uuid.UUID `db:"user_id,index"`
	Role     string    `db:"role"`
}

// Channel is a team channel (TeamID set) or a direct conversation (Kind
// "direct", DirectKey = DirectKey(a, b)).
type Channel struct {
	model.BaseModel
	TenantID  uuid.UUID  `db:"tenant_id,index"`
	TeamID    *uuid.UUID `db:"team_id,index"`
	Kind      string     `db:"kind"`
	Name      string     `db:"name"`
	DirectKey string     `db:"direct_key"`
}

type ChannelMember struct {
	model.BaseModel
	TenantID   uuid.UUID  `db:"tenant_id,index"`
	ChannelID  uuid.UUID  `db:"channel_id,index"`
	UserID     uuid.UUID  `db:"user_id,index"`
	LastReadAt *time.Time `db:"last_read_at"`
	// Position is the user's own sidebar order of the channel (nil = unordered, last).
	Position *int `db:"position"`
}

type Message struct {
	model.BaseModel
	TenantID  uuid.UUID `db:"tenant_id,index"`
	ChannelID uuid.UUID `db:"channel_id,index"`
	AuthorID  uuid.UUID `db:"author_id"`
	Body      string    `db:"body"`
}

type Attachment struct {
	model.BaseModel
	TenantID  uuid.UUID `db:"tenant_id,index"`
	MessageID uuid.UUID `db:"message_id,index"`
	Filename  string    `db:"filename"`
	Mime      string    `db:"mime"`
	Size      int64     `db:"size"`
	ObjectKey string    `db:"object_key"`
}

type Reaction struct {
	model.BaseModel
	TenantID  uuid.UUID `db:"tenant_id,index"`
	MessageID uuid.UUID `db:"message_id,index"`
	UserID    uuid.UUID `db:"user_id"`
	Emoji     string    `db:"emoji"`
}

type Folder struct {
	model.BaseModel
	TenantID  uuid.UUID  `db:"tenant_id,index"`
	TeamID    uuid.UUID  `db:"team_id,index"`
	ParentID  *uuid.UUID `db:"parent_id"`
	Name      string     `db:"name"`
	CreatedBy uuid.UUID  `db:"created_by"`
}

type File struct {
	model.BaseModel
	TenantID   uuid.UUID  `db:"tenant_id,index"`
	TeamID     uuid.UUID  `db:"team_id,index"`
	FolderID   *uuid.UUID `db:"folder_id"`
	Name       string     `db:"name"`
	Mime       string     `db:"mime"`
	Size       int64      `db:"size"`
	ObjectKey  string     `db:"object_key"`
	UploadedBy uuid.UUID  `db:"uploaded_by"`
}

type Share struct {
	model.BaseModel
	TenantID uuid.UUID `db:"tenant_id,index"`
	FileID   uuid.UUID `db:"file_id,index"`
	UserID   uuid.UUID `db:"user_id,index"`
}

// Table names: the repository derives them from these, matching modules/teams' registration.
func (Team) TableName() string          { return "team" }
func (Member) TableName() string        { return "team_member" }
func (Channel) TableName() string       { return "chat_channel" }
func (ChannelMember) TableName() string { return "chat_channel_member" }
func (Message) TableName() string       { return "chat_message" }
func (Attachment) TableName() string    { return "chat_attachment" }
func (Reaction) TableName() string      { return "chat_reaction" }
func (Folder) TableName() string        { return "team_folder" }
func (File) TableName() string          { return "team_file" }
func (Share) TableName() string         { return "team_file_share" }
