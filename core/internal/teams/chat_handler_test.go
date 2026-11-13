package teams_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http/httptest"
	"net/url"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"core/internal/auth"
	"core/internal/notify"
	"core/internal/teams"

	"github.com/google/uuid"
)

type pushed struct {
	tenant  uuid.UUID
	users   []uuid.UUID
	payload map[string]any
}

type fakePusher struct {
	mu     sync.Mutex
	frames []pushed
}

func (p *fakePusher) SendToUsers(tenant uuid.UUID, users []uuid.UUID, payload []byte) {
	var m map[string]any
	_ = json.Unmarshal(payload, &m)
	p.mu.Lock()
	defer p.mu.Unlock()
	p.frames = append(p.frames, pushed{tenant, slices.Clone(users), m})
}

type sentNote struct {
	user uuid.UUID
	msg  notify.Message
}

type fakeNotifier struct{ sent []sentNote }

func (n *fakeNotifier) Personal(_ context.Context, _, user uuid.UUID, m notify.Message) (notify.Notification, error) {
	n.sent = append(n.sent, sentNote{user, m})
	return notify.Notification{}, nil
}

type memStore struct {
	mu   sync.Mutex
	objs map[string][]byte
}

func (s *memStore) Put(_ context.Context, key, _ string, _ int64, body io.Reader) error {
	b, err := io.ReadAll(body)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.objs[key] = b
	return err
}

func (s *memStore) Get(_ context.Context, key string) (io.ReadCloser, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return io.NopCloser(bytes.NewReader(s.objs[key])), "application/octet-stream", nil
}

func (s *memStore) Delete(_ context.Context, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.objs, key)
	return nil
}

type chatFixture struct {
	fixture
	hub     *fakePusher
	notes   *fakeNotifier
	store   *memStore
	general uuid.UUID
}

func newChatFixture(t *testing.T, withStore bool) chatFixture {
	t.Helper()
	f := chatFixture{fixture: newFixture(t), hub: &fakePusher{}, notes: &fakeNotifier{}}
	if withStore {
		f.store = &memStore{objs: map[string][]byte{}}
		f.h = teams.NewHandler(f.repo, auth.NewUserRepository(f.app.DB), f.hub, f.notes, f.store)
	} else {
		f.h = teams.NewHandler(f.repo, auth.NewUserRepository(f.app.DB), f.hub, f.notes, nil)
	}
	chs, err := f.repo.ListChannels(context.Background(), f.tenant, f.team)
	if err != nil || len(chs) != 1 {
		t.Fatalf("channels: %v %v", chs, err)
	}
	f.general = chs[0].ID
	return f
}

func (f chatFixture) post(t *testing.T, as, channel uuid.UUID, body string) map[string]any {
	t.Helper()
	rec := serve(t, f.h.PostMessage, "POST", body, f.as(as), map[string]string{"channel": channel.String()})
	if rec.Code != 201 {
		t.Fatalf("post: %d %s", rec.Code, rec.Body)
	}
	var m map[string]any
	_ = jsonDecode(rec, &m)
	return m
}

func (f chatFixture) countMessages(t *testing.T, channel uuid.UUID) int {
	t.Helper()
	var n int
	if err := f.app.DB.QueryRow(context.Background(), `SELECT count(*) FROM chat_message WHERE channel_id=$1`, channel).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func sameSet(a, b []uuid.UUID) bool {
	a, b = slices.Clone(a), slices.Clone(b)
	cmp := func(x, y uuid.UUID) int { return strings.Compare(x.String(), y.String()) }
	slices.SortFunc(a, cmp)
	slices.SortFunc(b, cmp)
	return slices.Equal(a, b)
}

func TestPostMessage_GuestForbidden(t *testing.T) {
	f := newChatFixture(t, false)
	rec := serve(t, f.h.PostMessage, "POST", `{"body":"hi"}`, f.as(f.guest), map[string]string{"channel": f.general.String()})
	if rec.Code != 403 {
		t.Fatalf("guest post: %d %s", rec.Code, rec.Body)
	}
	if n := f.countMessages(t, f.general); n != 0 {
		t.Fatalf("rows = %d", n)
	}
	if rec := serve(t, f.h.PostMessage, "POST", `{"body":"hi"}`, f.as(f.outside), map[string]string{"channel": f.general.String()}); rec.Code != 404 {
		t.Fatalf("outsider post: %d", rec.Code)
	}
	if rec := serve(t, f.h.PostMessage, "POST", `{"body":"  "}`, f.as(f.member), map[string]string{"channel": f.general.String()}); rec.Code != 422 {
		t.Fatalf("empty post: %d", rec.Code)
	}
	if rec := serve(t, f.h.PostMessage, "POST", `{"body":"`+strings.Repeat("é", 4001)+`"}`, f.as(f.member), map[string]string{"channel": f.general.String()}); rec.Code != 422 {
		t.Fatalf("long post: %d", rec.Code)
	}
}

func TestPostMessage_PushesToTeamAudienceOnly(t *testing.T) {
	f := newChatFixture(t, false)
	m := f.post(t, f.member, f.general, `{"body":"hello"}`)
	if m["body"] != "hello" || m["author_id"] != f.member.String() || m["author_name"] != f.member.String()+"@t.test" {
		t.Fatalf("wire: %v", m)
	}
	if len(f.hub.frames) != 1 {
		t.Fatalf("frames: %d", len(f.hub.frames))
	}
	fr := f.hub.frames[0]
	if fr.tenant != f.tenant || !sameSet(fr.users, []uuid.UUID{f.owner, f.member, f.guest}) {
		t.Fatalf("recipients: %v", fr.users)
	}
	if fr.payload["type"] != "chat_message" || fr.payload["channel_id"] != f.general.String() || fr.payload["team_id"] != f.team.String() {
		t.Fatalf("frame: %v", fr.payload)
	}
}

func TestMentions_OnlyReaders(t *testing.T) {
	f := newChatFixture(t, false)
	body := `{"body":"hey @all","mentions":["` + f.guest.String() + `","` + f.outside.String() + `","` + f.member.String() + `"]}`
	f.post(t, f.member, f.general, body)
	if len(f.notes.sent) != 1 || f.notes.sent[0].user != f.guest {
		t.Fatalf("notified: %+v", f.notes.sent)
	}
	n := f.notes.sent[0].msg
	if n.Category != "teams" || n.Link != "/teams/"+f.team.String()+"/channels/"+f.general.String() ||
		n.Title != f.member.String()+"@t.test mentioned you" || n.Body != "hey @all" {
		t.Fatalf("message: %+v", n)
	}
}

func direct(t *testing.T, f chatFixture, as, with uuid.UUID) (int, uuid.UUID) {
	t.Helper()
	rec := serve(t, f.h.OpenDirect, "POST", `{"user_id":"`+with.String()+`"}`, f.as(as), nil)
	var out struct{ ID uuid.UUID }
	_ = jsonDecode(rec, &out)
	return rec.Code, out.ID
}

func cleanupDirect(t *testing.T, f chatFixture, id uuid.UUID) {
	t.Cleanup(func() {
		ctx := context.Background()
		_, _ = f.app.DB.Exec(ctx, `DELETE FROM chat_message WHERE channel_id=$1`, id)
		_, _ = f.app.DB.Exec(ctx, `DELETE FROM chat_channel_member WHERE channel_id=$1`, id)
		_, _ = f.app.DB.Exec(ctx, `DELETE FROM chat_channel WHERE id=$1`, id)
	})
}

func TestDirect_SelfIs422(t *testing.T) {
	f := newChatFixture(t, false)
	if code, _ := direct(t, f, f.owner, f.owner); code != 422 {
		t.Fatalf("self: %d", code)
	}
	if code, _ := direct(t, f, f.owner, f.website); code != 422 {
		t.Fatalf("website user: %d", code)
	}
	if code, _ := direct(t, f, f.owner, uuid.New()); code != 422 {
		t.Fatalf("unknown user: %d", code)
	}
}

func TestDirect_IdempotentPair(t *testing.T) {
	f := newChatFixture(t, false)
	code, a := direct(t, f, f.owner, f.staff)
	if code != 200 || a == uuid.Nil {
		t.Fatalf("open: %d", code)
	}
	cleanupDirect(t, f, a)
	if code, b := direct(t, f, f.staff, f.owner); code != 200 || b != a {
		t.Fatalf("reopen: %d %s != %s", code, b, a)
	}
	var n int
	_ = f.app.DB.QueryRow(context.Background(), `SELECT count(*) FROM chat_channel_member WHERE channel_id=$1`, a).Scan(&n)
	if n != 2 {
		t.Fatalf("members = %d", n)
	}
	f.post(t, f.staff, a, `{"body":"psst","mentions":["`+f.owner.String()+`"]}`)
	if fr := f.hub.frames[0]; !sameSet(fr.users, []uuid.UUID{f.owner, f.staff}) || fr.payload["team_id"] != nil {
		t.Fatalf("direct frame: %v %v", fr.users, fr.payload)
	}
	if len(f.notes.sent) != 1 || f.notes.sent[0].msg.Link != "/teams/direct/"+a.String() {
		t.Fatalf("direct mention: %+v", f.notes.sent)
	}
	rec := serve(t, f.h.ListDirect, "GET", "", f.as(f.owner), nil)
	var out struct {
		Data []struct {
			ID            uuid.UUID
			Unread        int
			LastMessageAt *time.Time             `json:"last_message_at"`
			OtherUser     struct{ ID uuid.UUID } `json:"other_user"`
		}
	}
	if err := jsonDecode(rec, &out); err != nil || len(out.Data) != 1 || out.Data[0].ID != a ||
		out.Data[0].OtherUser.ID != f.staff || out.Data[0].Unread != 1 || out.Data[0].LastMessageAt == nil {
		t.Fatalf("list direct: %v %s", err, rec.Body)
	}
}

func TestDirect_OutsiderGets404(t *testing.T) {
	f := newChatFixture(t, false)
	_, a := direct(t, f, f.owner, f.staff)
	cleanupDirect(t, f, a)
	p := map[string]string{"channel": a.String()}
	if rec := serve(t, f.h.ListMessages, "GET", "", f.as(f.member), p); rec.Code != 404 {
		t.Fatalf("outsider read: %d", rec.Code)
	}
	if rec := serve(t, f.h.PostMessage, "POST", `{"body":"x"}`, f.as(f.member), p); rec.Code != 404 {
		t.Fatalf("outsider post: %d", rec.Code)
	}
	if rec := serve(t, f.h.ListMessages, "GET", "", f.as(f.staff), p); rec.Code != 200 {
		t.Fatalf("participant read: %d", rec.Code)
	}
}

func channelUnread(t *testing.T, f chatFixture, as uuid.UUID) int {
	t.Helper()
	rec := serve(t, f.h.ListChannels, "GET", "", f.as(as), map[string]string{"id": f.team.String()})
	var out struct{ Data []struct{ Unread int } }
	if err := jsonDecode(rec, &out); err != nil || len(out.Data) != 1 {
		t.Fatalf("channels: %s", rec.Body)
	}
	return out.Data[0].Unread
}

func TestUnread_CountsOthersSinceCursor(t *testing.T) {
	f := newChatFixture(t, false)
	f.post(t, f.member, f.general, `{"body":"1"}`)
	f.post(t, f.guest2(t), f.general, `{"body":"2"}`)
	f.post(t, f.owner, f.general, `{"body":"mine"}`)
	if n := channelUnread(t, f, f.owner); n != 2 {
		t.Fatalf("unread = %d", n)
	}
	rec := serve(t, f.h.ListTeams, "GET", "", f.as(f.owner), nil)
	if !strings.Contains(rec.Body.String(), `"unread":2`) {
		t.Fatalf("team unread: %s", rec.Body)
	}
	// guests may mark as read
	if rec := serve(t, f.h.MarkRead, "POST", "", f.as(f.guest), map[string]string{"channel": f.general.String()}); rec.Code != 204 {
		t.Fatalf("guest read: %d", rec.Code)
	}
	if rec := serve(t, f.h.MarkRead, "POST", "", f.as(f.owner), map[string]string{"channel": f.general.String()}); rec.Code != 204 {
		t.Fatalf("read: %d", rec.Code)
	}
	if n := channelUnread(t, f, f.owner); n != 0 {
		t.Fatalf("after read = %d", n)
	}
	// marking twice upserts the same cursor
	serve(t, f.h.MarkRead, "POST", "", f.as(f.owner), map[string]string{"channel": f.general.String()})
	f.post(t, f.member, f.general, `{"body":"3"}`)
	if n := channelUnread(t, f, f.owner); n != 1 {
		t.Fatalf("after new = %d", n)
	}
}

// guest2 promotes a second writer so two different authors post.
func (f chatFixture) guest2(t *testing.T) uuid.UUID {
	t.Helper()
	if err := f.repo.SetRole(context.Background(), f.tenant, f.team, f.guest, teams.RoleMember); err != nil {
		t.Fatal(err)
	}
	return f.guest
}

func TestReaction_Toggle(t *testing.T) {
	f := newChatFixture(t, false)
	m := f.post(t, f.member, f.general, `{"body":"react"}`)
	p := map[string]string{"message": m["id"].(string)}
	type out struct {
		Reactions []struct {
			Emoji string
			Count int
			Mine  bool
		}
	}
	rec := serve(t, f.h.ToggleReaction, "POST", `{"emoji":"👍"}`, f.as(f.owner), p)
	var o out
	if err := jsonDecode(rec, &o); rec.Code != 200 || err != nil || len(o.Reactions) != 1 || o.Reactions[0].Count != 1 || !o.Reactions[0].Mine {
		t.Fatalf("add: %d %s", rec.Code, rec.Body)
	}
	fr := f.hub.frames[len(f.hub.frames)-1]
	rs := fr.payload["reactions"].([]any)
	if fr.payload["type"] != "chat_reaction" || len(rs) != 1 || rs[0].(map[string]any)["mine"] != nil {
		t.Fatalf("frame: %v", fr.payload)
	}
	rec = serve(t, f.h.ToggleReaction, "POST", `{"emoji":"👍"}`, f.as(f.owner), p)
	o = out{}
	if err := jsonDecode(rec, &o); rec.Code != 200 || err != nil || len(o.Reactions) != 0 {
		t.Fatalf("remove: %d %s", rec.Code, rec.Body)
	}
	if rec := serve(t, f.h.ToggleReaction, "POST", `{"emoji":"👍"}`, f.as(f.guest), p); rec.Code != 403 {
		t.Fatalf("guest react: %d", rec.Code)
	}
	if rec := serve(t, f.h.ToggleReaction, "POST", `{"emoji":"`+strings.Repeat("x", 17)+`"}`, f.as(f.owner), p); rec.Code != 422 {
		t.Fatalf("long emoji: %d", rec.Code)
	}
	if rec := serve(t, f.h.ToggleReaction, "POST", `{"emoji":"👍"}`, f.as(f.outside), p); rec.Code != 404 {
		t.Fatalf("outsider react: %d", rec.Code)
	}
}

func TestDeleteMessage(t *testing.T) {
	f := newChatFixture(t, false)
	m := f.post(t, f.member, f.general, `{"body":"oops"}`)
	p := map[string]string{"message": m["id"].(string)}
	other := f.post(t, f.owner, f.general, `{"body":"owner's"}`)
	op := map[string]string{"message": other["id"].(string)}
	if rec := serve(t, f.h.DeleteMessage, "DELETE", "", f.as(f.outside), p); rec.Code != 404 {
		t.Fatalf("outsider: %d", rec.Code)
	}
	if rec := serve(t, f.h.DeleteMessage, "DELETE", "", f.as(f.guest), p); rec.Code != 403 {
		t.Fatalf("guest: %d", rec.Code)
	}
	if rec := serve(t, f.h.DeleteMessage, "DELETE", "", f.as(f.member), op); rec.Code != 403 {
		t.Fatalf("member deleting another's: %d", rec.Code)
	}
	if rec := serve(t, f.h.DeleteMessage, "DELETE", "", f.as(f.member), p); rec.Code != 204 {
		t.Fatalf("author: %d %s", rec.Code, rec.Body)
	}
	fr := f.hub.frames[len(f.hub.frames)-1]
	if fr.payload["type"] != "chat_message_deleted" || fr.payload["message_id"] != m["id"] {
		t.Fatalf("frame: %v", fr.payload)
	}
	// Gone: a second delete, a reaction and the list no longer find it.
	if rec := serve(t, f.h.DeleteMessage, "DELETE", "", f.as(f.member), p); rec.Code != 404 {
		t.Fatalf("again: %d", rec.Code)
	}
	if rec := serve(t, f.h.ToggleReaction, "POST", `{"emoji":"👍"}`, f.as(f.owner), p); rec.Code != 404 {
		t.Fatalf("react on deleted: %d", rec.Code)
	}
	rec := serve(t, f.h.ListMessages, "GET", "", f.as(f.owner), map[string]string{"channel": f.general.String()})
	if strings.Contains(rec.Body.String(), "oops") {
		t.Fatalf("still listed: %s", rec.Body)
	}
	// An owner deletes anyone's message.
	byMember := f.post(t, f.member, f.general, `{"body":"by member"}`)
	if rec := serve(t, f.h.DeleteMessage, "DELETE", "", f.as(f.owner), map[string]string{"message": byMember["id"].(string)}); rec.Code != 204 {
		t.Fatalf("owner: %d", rec.Code)
	}
	if rec := serve(t, f.h.DeleteMessage, "DELETE", "", f.as(f.member), map[string]string{"message": "x"}); rec.Code != 404 {
		t.Fatalf("bad id: %d", rec.Code)
	}
}

func multipartReq(t *testing.T, body string, files map[string]string) (*bytes.Buffer, string) {
	t.Helper()
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	_ = w.WriteField("body", body)
	for name, content := range files {
		fw, err := w.CreateFormFile("files", name)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = fw.Write([]byte(content))
	}
	_ = w.Close()
	return &buf, w.FormDataContentType()
}

func TestPostMessage_MultipartFile(t *testing.T) {
	f := newChatFixture(t, true)
	buf, ct := multipartReq(t, "", map[string]string{"notes.txt": "hello file"})
	req := httptest.NewRequest("POST", "/", buf)
	req.Header.Set("Content-Type", ct)
	rec := serveReq(t, f.h.PostMessage, req, f.as(f.member), map[string]string{"channel": f.general.String()})
	if rec.Code != 201 {
		t.Fatalf("post: %d %s", rec.Code, rec.Body)
	}
	var m struct {
		Attachments []struct {
			ID       uuid.UUID
			Kind     string
			Filename string
			Size     int64
		}
	}
	if err := jsonDecode(rec, &m); err != nil || len(m.Attachments) != 1 || m.Attachments[0].Kind != "file" ||
		m.Attachments[0].Filename != "notes.txt" || m.Attachments[0].Size != 10 {
		t.Fatalf("wire: %s", rec.Body)
	}
	for k := range f.store.objs {
		if !strings.HasPrefix(k, f.tenant.String()+"/teams/") {
			t.Fatalf("key %q", k)
		}
	}
	p := map[string]string{"file": m.Attachments[0].ID.String()}
	rec = serve(t, f.h.DownloadFile, "GET", "", f.as(f.guest), p)
	if rec.Code != 200 || rec.Body.String() != "hello file" || !strings.Contains(rec.Header().Get("Content-Disposition"), `filename=notes.txt`) {
		t.Fatalf("download: %d %q %q", rec.Code, rec.Body, rec.Header().Get("Content-Disposition"))
	}
	if rec := serve(t, f.h.DownloadFile, "GET", "", f.as(f.outside), p); rec.Code != 404 {
		t.Fatalf("outsider download: %d", rec.Code)
	}
	// deleting the channel removes its messages but the files outlive the chat
	if _, err := f.repo.CreateChannel(context.Background(), f.tenant, f.team, "other"); err != nil {
		t.Fatal(err)
	}
	if rec := serve(t, f.h.DeleteChannel, "DELETE", "", f.as(f.owner), map[string]string{"id": f.team.String(), "channel": f.general.String()}); rec.Code != 204 {
		t.Fatalf("delete channel: %d", rec.Code)
	}
	if len(f.store.objs) != 1 || f.countMessages(t, f.general) != 0 {
		t.Fatalf("after delete: %d objects, %d messages", len(f.store.objs), f.countMessages(t, f.general))
	}
	if rec := serve(t, f.h.DownloadFile, "GET", "", f.as(f.guest), p); rec.Code != 200 {
		t.Fatalf("download after channel delete: %d", rec.Code)
	}
}

func TestPostMessage_NoS3Multipart503(t *testing.T) {
	f := newChatFixture(t, false)
	buf, ct := multipartReq(t, "hi", map[string]string{"a.txt": "x"})
	req := httptest.NewRequest("POST", "/", buf)
	req.Header.Set("Content-Type", ct)
	rec := serveReq(t, f.h.PostMessage, req, f.as(f.member), map[string]string{"channel": f.general.String()})
	if rec.Code != 503 || !strings.Contains(rec.Body.String(), "STORAGE_UNAVAILABLE") {
		t.Fatalf("got %d %s", rec.Code, rec.Body)
	}
}

func TestListMessages_BeforePagination(t *testing.T) {
	f := newChatFixture(t, false)
	for _, b := range []string{"a", "b", "c"} {
		f.post(t, f.member, f.general, `{"body":"`+b+`"}`)
	}
	type page struct {
		Data []struct {
			Body      string
			CreatedAt time.Time `json:"created_at"`
		}
	}
	p := map[string]string{"channel": f.general.String()}
	req := httptest.NewRequest("GET", "/?limit=2", nil)
	rec := serveReq(t, f.h.ListMessages, req, f.as(f.guest), p)
	var first page
	if err := jsonDecode(rec, &first); err != nil || len(first.Data) != 2 || first.Data[0].Body != "c" || first.Data[1].Body != "b" {
		t.Fatalf("first page: %s", rec.Body)
	}
	req = httptest.NewRequest("GET", "/?limit=2&before="+url.QueryEscape(first.Data[1].CreatedAt.Format(time.RFC3339Nano)), nil)
	rec = serveReq(t, f.h.ListMessages, req, f.as(f.guest), p)
	var second page
	if err := jsonDecode(rec, &second); err != nil || len(second.Data) != 1 || second.Data[0].Body != "a" {
		t.Fatalf("second page: %s", rec.Body)
	}
	req = httptest.NewRequest("GET", "/?before=nope", nil)
	if rec := serveReq(t, f.h.ListMessages, req, f.as(f.guest), p); rec.Code != 400 {
		t.Fatalf("bad before: %d", rec.Code)
	}
}
