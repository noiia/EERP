package teams

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"mime/multipart"
	"net/http"
	"strconv"
	"strings"
	"time"

	"core/internal/auth"
	"core/internal/common"
	"core/internal/notify"
	"core/orm"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
	"go.uber.org/zap"
)

const (
	maxBodyChars = 4000
	maxEmojiLen  = 16 // bytes
)

type attachmentJSON struct {
	ID       uuid.UUID `json:"id"`
	Filename string    `json:"filename"`
	Mime     string    `json:"mime"`
	Size     int64     `json:"size"`
}

type reactionJSON struct {
	Emoji string `json:"emoji"`
	Count int    `json:"count"`
	Mine  bool   `json:"mine"`
}

// frameReaction is reactionJSON without mine: one frame goes to every reader.
type frameReaction struct {
	Emoji string `json:"emoji"`
	Count int    `json:"count"`
}

type messageJSON struct {
	ID              uuid.UUID        `json:"id"`
	ChannelID       uuid.UUID        `json:"channel_id"`
	AuthorID        uuid.UUID        `json:"author_id"`
	AuthorName      string           `json:"author_name"`
	AuthorHasAvatar bool             `json:"author_has_avatar"`
	Body            string           `json:"body"`
	CreatedAt       time.Time        `json:"created_at"`
	Attachments     []attachmentJSON `json:"attachments"`
	Reactions       []reactionJSON   `json:"reactions"`
}

type messageFrame struct {
	Type      string      `json:"type"`
	ChannelID uuid.UUID   `json:"channel_id"`
	TeamID    *uuid.UUID  `json:"team_id"`
	Message   messageJSON `json:"message"`
}

type reactionFrame struct {
	Type      string          `json:"type"`
	ChannelID uuid.UUID       `json:"channel_id"`
	MessageID uuid.UUID       `json:"message_id"`
	Reactions []frameReaction `json:"reactions"`
}

func notFound(c *echo.Context, what string) error {
	return errorJSON(c, http.StatusNotFound, "NOT_FOUND", "No such "+what+".")
}

// participants splits a DirectKey into its two users.
func participants(key string) []uuid.UUID {
	var out []uuid.UUID
	for _, s := range strings.Split(key, ":") {
		if id, err := uuid.Parse(s); err == nil {
			out = append(out, id)
		}
	}
	return out
}

// channelAccess resolves the caller's role in a channel and the users who read
// it: a team channel's audience (CanSeeChannel / ChannelAudience), or a direct
// conversation's two participants (role member). Anyone else, including a team
// member the channel's access list leaves out, gets a 404 (already written; role is then empty).
func (h *Handler) channelAccess(c *echo.Context, channel uuid.UUID) (Channel, string, []uuid.UUID, error) {
	ctx := c.Request().Context()
	id := auth.MustIdentity(ctx)
	ch, err := h.repo.FindChannel(ctx, id.TenantID, channel)
	if errors.Is(err, orm.ErrNotFound) {
		return Channel{}, "", nil, notFound(c, "channel")
	}
	if err != nil {
		return Channel{}, "", nil, err
	}
	if ch.TeamID == nil {
		users := participants(ch.DirectKey)
		for _, u := range users {
			if u == id.UserID {
				return ch, RoleMember, users, nil
			}
		}
		return Channel{}, "", nil, notFound(c, "channel")
	}
	role, err := h.repo.RoleOf(ctx, id.TenantID, *ch.TeamID, id.UserID)
	if errors.Is(err, orm.ErrNotFound) {
		return Channel{}, "", nil, notFound(c, "channel")
	}
	if err != nil {
		return Channel{}, "", nil, err
	}
	ok, err := h.repo.CanSeeChannel(ctx, id.TenantID, ch, id.UserID, role)
	if err != nil {
		return Channel{}, "", nil, err
	}
	if !ok {
		return Channel{}, "", nil, notFound(c, "channel")
	}
	audience, err := h.repo.ChannelAudience(ctx, id.TenantID, ch)
	if err != nil {
		return Channel{}, "", nil, err
	}
	return ch, role, audience, nil
}

// paramAccess is channelAccess on the :channel path param.
func (h *Handler) paramAccess(c *echo.Context) (Channel, string, []uuid.UUID, error) {
	chID, err := echo.PathParam[uuid.UUID](c, "channel")
	if err != nil {
		return Channel{}, "", nil, notFound(c, "channel")
	}
	return h.channelAccess(c, chID)
}

func forbidden(c *echo.Context) error {
	return errorJSON(c, http.StatusForbidden, "FORBIDDEN", "Your role does not allow this.")
}

func (h *Handler) userMap(ctx context.Context, tenant uuid.UUID) (map[uuid.UUID]auth.Users, error) {
	us, err := h.users.ListByTenant(ctx, tenant)
	if err != nil {
		return nil, err
	}
	out := make(map[uuid.UUID]auth.Users, len(us))
	for _, u := range us {
		out[u.ID] = u
	}
	return out, nil
}

// wire renders messages with their attachments and reactions (mine for viewer).
func (h *Handler) wire(ctx context.Context, tenant, viewer uuid.UUID, msgs []Message) ([]messageJSON, error) {
	ids := make([]uuid.UUID, len(msgs))
	for i, m := range msgs {
		ids[i] = m.ID
	}
	atts, err := h.repo.AttachmentsOf(ctx, tenant, ids)
	if err != nil {
		return nil, err
	}
	reacts, err := h.repo.ReactionsOf(ctx, tenant, viewer, ids)
	if err != nil {
		return nil, err
	}
	users, err := h.userMap(ctx, tenant)
	if err != nil {
		return nil, err
	}
	out := make([]messageJSON, len(msgs))
	for i, m := range msgs {
		w := messageJSON{ID: m.ID, ChannelID: m.ChannelID, AuthorID: m.AuthorID, AuthorName: displayName(users[m.AuthorID]), AuthorHasAvatar: hasAvatar(users[m.AuthorID]),
			Body: m.Body, CreatedAt: m.CreatedAt, Attachments: []attachmentJSON{}, Reactions: []reactionJSON{}}
		for _, a := range atts[m.ID] {
			w.Attachments = append(w.Attachments, attachmentJSON{a.ID, a.Filename, a.Mime, a.Size})
		}
		for _, r := range reacts[m.ID] {
			w.Reactions = append(w.Reactions, reactionJSON(r))
		}
		out[i] = w
	}
	return out, nil
}

func (h *Handler) push(tenant uuid.UUID, users []uuid.UUID, frame any) {
	if h.hub == nil {
		return
	}
	b, err := json.Marshal(frame)
	if err != nil {
		return
	}
	h.hub.SendToUsers(tenant, users, b)
}

// ListMessages serves GET /channels/:channel/messages: newest first, ?before=<RFC3339>, ?limit (50, max 100).
func (h *Handler) ListMessages(c *echo.Context) error {
	ch, role, _, err := h.paramAccess(c)
	if role == "" {
		return err
	}
	var before *time.Time
	if s := c.QueryParam("before"); s != "" {
		t, err := time.Parse(time.RFC3339Nano, s)
		if err != nil {
			return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "before must be an RFC3339 timestamp.")
		}
		before = &t
	}
	limit, err := strconv.Atoi(c.QueryParam("limit"))
	if err != nil || limit < 1 {
		limit = 50
	}
	limit = min(limit, 100)
	ctx := c.Request().Context()
	id := auth.MustIdentity(ctx)
	msgs, err := h.repo.ListMessages(ctx, id.TenantID, ch.ID, before, limit)
	if err != nil {
		return err
	}
	out, err := h.wire(ctx, id.TenantID, id.UserID, msgs)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, map[string]any{"data": out})
}

type postBody struct {
	Body     string      `json:"body"`
	Mentions []uuid.UUID `json:"mentions"`
}

// PostMessage serves POST /channels/:channel/messages, JSON {body, mentions} or
// multipart (body, repeated mentions, repeated files).
func (h *Handler) PostMessage(c *echo.Context) error {
	ch, role, audience, err := h.paramAccess(c)
	if role == "" {
		return err
	}
	if !CanWrite(role) {
		return forbidden(c)
	}
	var b postBody
	var files []*multipart.FileHeader
	if strings.HasPrefix(c.Request().Header.Get(echo.HeaderContentType), echo.MIMEMultipartForm) {
		if h.objects == nil {
			return errorJSON(c, http.StatusServiceUnavailable, "STORAGE_UNAVAILABLE", "File storage is not configured.")
		}
		form, err := c.MultipartForm()
		if err != nil {
			return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed multipart body.")
		}
		if v := form.Value["body"]; len(v) > 0 {
			b.Body = v[0]
		}
		for _, s := range form.Value["mentions"] {
			if u, err := uuid.Parse(s); err == nil {
				b.Mentions = append(b.Mentions, u)
			}
		}
		files = form.File["files"]
	} else if err := c.Bind(&b); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}
	b.Body = strings.TrimSpace(b.Body)
	if len([]rune(b.Body)) > maxBodyChars {
		return errorJSON(c, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "A message is at most 4000 characters.")
	}
	if b.Body == "" && len(files) == 0 {
		return errorJSON(c, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "A message needs a body or a file.")
	}
	for _, f := range files {
		if f.Filename == "" {
			return errorJSON(c, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "Every uploaded file needs a name.")
		}
	}

	ctx := c.Request().Context()
	id := auth.MustIdentity(ctx)
	stored, err := h.storeFiles(ctx, id.TenantID, files)
	if err != nil {
		return err
	}
	keys := make([]string, len(stored)) // kept apart: CreateMessage returns nil attachments on failure
	for i, a := range stored {
		keys[i] = a.ObjectKey
	}
	m, _, err := h.repo.CreateMessage(ctx, Message{TenantID: id.TenantID, ChannelID: ch.ID, AuthorID: id.UserID, Body: b.Body}, stored)
	if err != nil {
		h.deleteObjects(ctx, keys, "failed message insert")
		return err
	}
	out, err := h.wire(ctx, id.TenantID, id.UserID, []Message{m})
	if err != nil {
		return err
	}
	h.push(id.TenantID, audience, messageFrame{Type: "chat_message", ChannelID: ch.ID, TeamID: ch.TeamID, Message: out[0]})
	h.notifyMentions(ctx, id, ch, audience, b.Mentions, out[0])
	return c.JSON(http.StatusCreated, out[0])
}

// storeFiles uploads the files under <tenant>/teams/<uuid>; on failure the ones already stored are removed.
func (h *Handler) storeFiles(ctx context.Context, tenant uuid.UUID, files []*multipart.FileHeader) ([]Attachment, error) {
	var atts []Attachment
	undo := func() {
		keys := make([]string, len(atts))
		for i, a := range atts {
			keys[i] = a.ObjectKey
		}
		h.deleteObjects(ctx, keys, "failed upload")
	}
	for _, fh := range files {
		mt := fh.Header.Get("Content-Type")
		if mt == "" {
			mt = "application/octet-stream"
		}
		f, err := fh.Open()
		if err != nil {
			undo()
			return nil, fmt.Errorf("teams: open upload: %w", err)
		}
		key := fmt.Sprintf("%s/teams/%s", tenant, uuid.NewString())
		err = h.objects.Put(ctx, key, mt, fh.Size, f)
		_ = f.Close()
		if err != nil {
			undo()
			return nil, fmt.Errorf("teams: store object: %w", err)
		}
		atts = append(atts, Attachment{Filename: fh.Filename, Mime: mt, Size: fh.Size, ObjectKey: key})
	}
	return atts, nil
}

// notifyMentions notifies each mentioned reader of the channel except the author; failures are only logged.
func (h *Handler) notifyMentions(ctx context.Context, id auth.Identity, ch Channel, audience, mentions []uuid.UUID, m messageJSON) {
	if h.notifier == nil || len(mentions) == 0 {
		return
	}
	link := "/teams/direct/" + ch.ID.String()
	if ch.TeamID != nil {
		link = "/teams/" + ch.TeamID.String() + "/channels/" + ch.ID.String()
	}
	body := []rune(m.Body)
	if len(body) > 140 {
		body = body[:140]
	}
	readers := map[uuid.UUID]bool{}
	for _, u := range audience {
		readers[u] = true
	}
	delete(readers, id.UserID)
	for _, u := range mentions {
		if !readers[u] {
			continue
		}
		delete(readers, u) // once per user, even if mentioned twice
		if _, err := h.notifier.Personal(ctx, id.TenantID, u, notify.Message{Category: "teams",
			Title: m.AuthorName + " mentioned you", Body: string(body), Link: link}); err != nil && common.Logger != nil {
			common.Logger.Warn("teams: mention notification failed", zap.String("user", u.String()), zap.Error(err))
		}
	}
}

// MarkRead serves POST /channels/:channel/read: any reader, guests included.
func (h *Handler) MarkRead(c *echo.Context) error {
	ch, role, _, err := h.paramAccess(c)
	if role == "" {
		return err
	}
	ctx := c.Request().Context()
	id := auth.MustIdentity(ctx)
	if err := h.repo.MarkRead(ctx, id.TenantID, ch.ID, id.UserID); err != nil {
		return err
	}
	return c.NoContent(http.StatusNoContent)
}

// ToggleReaction serves POST /messages/:message/reactions {emoji}.
func (h *Handler) ToggleReaction(c *echo.Context) error {
	ctx := c.Request().Context()
	id := auth.MustIdentity(ctx)
	msgID, err := echo.PathParam[uuid.UUID](c, "message")
	if err != nil {
		return notFound(c, "message")
	}
	m, err := h.repo.FindMessage(ctx, id.TenantID, msgID)
	if errors.Is(err, orm.ErrNotFound) {
		return notFound(c, "message")
	}
	if err != nil {
		return err
	}
	_, role, audience, err := h.channelAccess(c, m.ChannelID)
	if role == "" {
		return err
	}
	if !CanWrite(role) {
		return forbidden(c)
	}
	var b struct {
		Emoji string `json:"emoji"`
	}
	if err := c.Bind(&b); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}
	b.Emoji = strings.TrimSpace(b.Emoji)
	if b.Emoji == "" || len(b.Emoji) > maxEmojiLen {
		return errorJSON(c, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "emoji must be 1-16 bytes.")
	}
	if err := h.repo.ToggleReaction(ctx, id.TenantID, m.ID, id.UserID, b.Emoji); err != nil {
		return err
	}
	counts, err := h.repo.ReactionsOf(ctx, id.TenantID, id.UserID, []uuid.UUID{m.ID})
	if err != nil {
		return err
	}
	out, frame := []reactionJSON{}, []frameReaction{}
	for _, r := range counts[m.ID] {
		out = append(out, reactionJSON(r))
		frame = append(frame, frameReaction{r.Emoji, r.Count})
	}
	h.push(id.TenantID, audience, reactionFrame{Type: "chat_reaction", ChannelID: m.ChannelID, MessageID: m.ID, Reactions: frame})
	return c.JSON(http.StatusOK, map[string]any{"reactions": out})
}

// GetAttachment serves GET /attachments/:id as a download, to the channel's readers only.
func (h *Handler) GetAttachment(c *echo.Context) error {
	ctx := c.Request().Context()
	id := auth.MustIdentity(ctx)
	attID, err := echo.PathParam[uuid.UUID](c, "id")
	if err != nil {
		return notFound(c, "attachment")
	}
	a, err := h.repo.FindAttachment(ctx, id.TenantID, attID)
	if errors.Is(err, orm.ErrNotFound) {
		return notFound(c, "attachment")
	}
	if err != nil {
		return err
	}
	m, err := h.repo.FindMessage(ctx, id.TenantID, a.MessageID)
	if errors.Is(err, orm.ErrNotFound) {
		return notFound(c, "attachment")
	}
	if err != nil {
		return err
	}
	if _, role, _, err := h.channelAccess(c, m.ChannelID); role == "" {
		return err
	}
	if h.objects == nil {
		return errorJSON(c, http.StatusServiceUnavailable, "STORAGE_UNAVAILABLE", "File storage is not configured.")
	}
	body, contentType, err := h.objects.Get(ctx, a.ObjectKey)
	if err != nil {
		return fmt.Errorf("teams: read object: %w", err)
	}
	defer func() { _ = body.Close() }()
	if a.Mime != "" {
		contentType = a.Mime
	}
	c.Response().Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": a.Filename}))
	return c.Stream(http.StatusOK, contentType, body)
}

type directJSON struct {
	ID            uuid.UUID     `json:"id"`
	OtherUser     directoryJSON `json:"other_user"`
	Unread        int           `json:"unread"`
	LastMessageAt *time.Time    `json:"last_message_at"`
}

func (h *Handler) directEntries(ctx context.Context, id auth.Identity) ([]directJSON, error) {
	ds, err := h.repo.ListDirect(ctx, id.TenantID, id.UserID)
	if err != nil {
		return nil, err
	}
	ids := make([]uuid.UUID, len(ds))
	for i, d := range ds {
		ids[i] = d.Channel.ID
	}
	unread, err := h.repo.UnreadCounts(ctx, id.TenantID, id.UserID, ids)
	if err != nil {
		return nil, err
	}
	users, err := h.userMap(ctx, id.TenantID)
	if err != nil {
		return nil, err
	}
	out := make([]directJSON, len(ds))
	for i, d := range ds {
		other := id.UserID
		for _, u := range participants(d.Channel.DirectKey) {
			if u != id.UserID {
				other = u
			}
		}
		u := users[other]
		out[i] = directJSON{d.Channel.ID, directoryJSON{other, displayName(u), u.Email, hasAvatar(u)}, unread[d.Channel.ID], d.LastMessageAt}
	}
	return out, nil
}

// ListDirect serves GET /direct: the caller's conversations, most recent first.
func (h *Handler) ListDirect(c *echo.Context) error {
	out, err := h.directEntries(c.Request().Context(), auth.MustIdentity(c.Request().Context()))
	if err != nil {
		return err
	}
	return list(c, out)
}

// OpenDirect serves POST /direct {user_id}: get or create the conversation with another staff user.
func (h *Handler) OpenDirect(c *echo.Context) error {
	ctx := c.Request().Context()
	id := auth.MustIdentity(ctx)
	var b struct {
		UserID uuid.UUID `json:"user_id"`
	}
	if err := c.Bind(&b); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}
	if b.UserID == id.UserID {
		return errorJSON(c, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "You can't start a conversation with yourself.")
	}
	users, err := h.userMap(ctx, id.TenantID)
	if err != nil {
		return err
	}
	if _, ok := users[b.UserID]; !ok {
		return errorJSON(c, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "user_id is not a staff user of this workspace.")
	}
	ch, err := h.repo.GetOrCreateDirect(ctx, id.TenantID, id.UserID, b.UserID)
	if err != nil {
		return err
	}
	all, err := h.directEntries(ctx, id)
	if err != nil {
		return err
	}
	for _, d := range all {
		if d.ID == ch.ID {
			return c.JSON(http.StatusOK, d)
		}
	}
	return orm.ErrNotFound
}

// SetDirectOrder serves PUT /direct/order: the caller's own order of their conversations.
func (h *Handler) SetDirectOrder(c *echo.Context) error {
	id := auth.MustIdentity(c.Request().Context())
	ds, err := h.repo.ListDirect(c.Request().Context(), id.TenantID, id.UserID)
	if err != nil {
		return err
	}
	ids := make(map[uuid.UUID]bool, len(ds))
	for _, d := range ds {
		ids[d.Channel.ID] = true
	}
	return h.setOrder(c, ids)
}
