package teams_test

import (
	"net/http/httptest"
	"testing"

	"core/internal/auth"
	"core/internal/teams"
	"core/internal/testdb"

	"github.com/google/uuid"
)

// folderCodes answers, per user, ListFiles ?folder= on folder and a download of file.
func (f privFixture) folderCodes(t *testing.T, folder, file uuid.UUID) map[uuid.UUID][2]int {
	t.Helper()
	out := map[uuid.UUID][2]int{}
	for _, u := range []uuid.UUID{f.owner, f.member, f.staff, f.unlisted} {
		req := httptest.NewRequest("GET", "/?folder="+folder.String(), nil)
		l := serveReq(t, f.h.ListFiles, req, f.as(u), f.teamP()).Code
		d := serve(t, f.h.DownloadFile, "GET", "", f.as(u), map[string]string{"file": file.String()}).Code
		out[u] = [2]int{l, d}
	}
	return out
}

// assertOwnersOnly: only the owner lists the folder and downloads its file.
func (f privFixture) assertOwnersOnly(t *testing.T, folder uuid.UUID) {
	t.Helper()
	for u, c := range f.folderCodes(t, folder, f.att) {
		want := 404
		if u == f.owner {
			want = 200
		}
		if c[0] != want || c[1] != want {
			t.Fatalf("user %s: list %d download %d, want %d", u, c[0], c[1], want)
		}
	}
}

func TestOwnersOnly_DeletePrivateChannel(t *testing.T) {
	f := newPrivFixture(t)
	secret := *f.linked(t, f.secret)
	sub := f.folder(t, f.member, f.team, `{"name":"sub","parent_id":"`+secret.String()+`"}`)
	if c := f.call(t, f.h.DeleteChannel, "DELETE", "", f.owner, f.chanP(f.secret)); c != 204 {
		t.Fatalf("delete channel: %d", c)
	}
	f.assertOwnersOnly(t, secret)
	req := httptest.NewRequest("GET", "/?folder="+sub.String(), nil)
	if c := serveReq(t, f.h.ListFiles, req, f.as(f.member), f.teamP()).Code; c != 404 {
		t.Fatalf("sub for member: %d", c)
	}
	// an explicit share still lets its recipient download
	if c := f.call(t, f.h.PutShares, "PUT", `{"user_ids":["`+f.unlisted.String()+`"]}`, f.owner,
		map[string]string{"file": f.att.String()}); c != 200 {
		t.Fatalf("share: %d", c)
	}
	if c := serve(t, f.h.DownloadFile, "GET", "", f.as(f.unlisted), map[string]string{"file": f.att.String()}).Code; c != 200 {
		t.Fatalf("shared download: %d", c)
	}
}

func TestOwnersOnly_UnlinkPrivateChannel(t *testing.T) {
	f := newPrivFixture(t)
	secret := *f.linked(t, f.secret)
	if c := f.call(t, f.h.RenameChannel, "PUT", `{"folder_id":""}`, f.owner, f.chanP(f.secret)); c != 200 {
		t.Fatalf("unlink: %d", c)
	}
	f.assertOwnersOnly(t, secret)
}

func TestOwnersOnly_RelinkThenLinkToOpen(t *testing.T) {
	f := newPrivFixture(t)
	secret := *f.linked(t, f.secret)
	other := f.folder(t, f.owner, f.team, `{"name":"other"}`)
	if c := f.call(t, f.h.RenameChannel, "PUT", `{"folder_id":"`+other.String()+`"}`, f.owner, f.chanP(f.secret)); c != 200 {
		t.Fatalf("relink: %d", c)
	}
	f.assertOwnersOnly(t, secret)
	// relinking the same folder changes nothing
	if c := f.call(t, f.h.RenameChannel, "PUT", `{"folder_id":"`+other.String()+`"}`, f.owner, f.chanP(f.secret)); c != 200 {
		t.Fatalf("same relink: %d", c)
	}
	// a non-owner can't move or delete a folder holding an owners-only one
	parent := f.folder(t, f.unlisted, f.team, `{"name":"P"}`)
	if c := f.call(t, f.h.UpdateFolder, "PUT", `{"parent_id":"`+parent.String()+`"}`, f.owner,
		map[string]string{"id": f.team.String(), "folder": secret.String()}); c != 200 {
		t.Fatalf("owner move: %d", c)
	}
	if c := f.call(t, f.h.DeleteFolder, "DELETE", "", f.unlisted, map[string]string{"id": f.team.String(), "folder": parent.String()}); c != 409 {
		t.Fatalf("member delete over owners-only: %d", c)
	}
	// the owner links it to an open conversation: its privacy follows that one
	if c := f.call(t, f.h.RenameChannel, "PUT", `{"folder_id":"`+secret.String()+`"}`, f.owner, f.chanP(f.general)); c != 200 {
		t.Fatalf("link to open: %d", c)
	}
	for u, c := range f.folderCodes(t, secret, f.att) {
		if c[0] != 200 || c[1] != 200 {
			t.Fatalf("user %s after open link: %v", u, c)
		}
	}
}

// Files sent into a folder under an owners-only one reach only owners in the frame.
func TestOwnersOnly_FrameRedacted(t *testing.T) {
	f := newPrivFixture(t)
	secret := *f.linked(t, f.secret)
	if c := f.call(t, f.h.DeleteChannel, "DELETE", "", f.owner, f.chanP(f.secret)); c != 204 {
		t.Fatalf("delete channel: %d", c)
	}
	sub := f.folder(t, f.owner, f.team, `{"name":"inner","parent_id":"`+secret.String()+`"}`)
	if c := f.call(t, f.h.RenameChannel, "PUT", `{"folder_id":"`+sub.String()+`"}`, f.owner, f.chanP(f.general)); c != 200 {
		t.Fatalf("link: %d", c)
	}
	f.hub.frames = nil
	if code, _ := f.sendFile(t, f.owner, f.general, "o.txt", "x"); code != 201 {
		t.Fatalf("send: %d", code)
	}
	for _, fr := range f.hub.frames {
		if fr.payload["type"] != "chat_message" {
			continue
		}
		att := fr.payload["message"].(map[string]any)["attachments"].([]any)[0].(map[string]any)
		for _, u := range fr.users {
			if (att["filename"] == "o.txt") != (u == f.owner) {
				t.Fatalf("frame for %s: %v", u, att)
			}
		}
	}
}

func TestMoveFolder_HiddenDescendant409(t *testing.T) {
	f := newPrivFixture(t)
	secret := f.linked(t, f.secret)
	projects := f.folder(t, f.unlisted, f.team, `{"name":"Projects"}`)
	dest := f.folder(t, f.unlisted, f.team, `{"name":"Archive"}`)
	if c := f.call(t, f.h.UpdateFolder, "PUT", `{"parent_id":"`+projects.String()+`"}`, f.owner,
		map[string]string{"id": f.team.String(), "folder": secret.String()}); c != 200 {
		t.Fatalf("move: %d", c)
	}
	p := map[string]string{"id": f.team.String(), "folder": projects.String()}
	if c := f.call(t, f.h.UpdateFolder, "PUT", `{"parent_id":"`+dest.String()+`"}`, f.unlisted, p); c != 409 {
		t.Fatalf("member move: %d", c)
	}
	if c := f.call(t, f.h.UpdateFolder, "PUT", `{"name":"Renamed"}`, f.unlisted, p); c != 200 {
		t.Fatalf("member rename: %d", c)
	}
	if c := f.call(t, f.h.UpdateFolder, "PUT", `{"parent_id":"`+dest.String()+`"}`, f.owner, p); c != 200 {
		t.Fatalf("owner move: %d", c)
	}
}

// closingPusher closes the handler's own pool on the first frame: everything
// after the push (the response's redaction) hits a dead database.
type closingPusher struct{ app interface{ Close() error } }

func (p closingPusher) SendToUsers(uuid.UUID, []uuid.UUID, []byte) { _ = p.app.Close() }

// The message is committed before the response's redaction: a lookup error there
// redacts every file and still answers 201, never a 500.
func TestPostMessage_RedactErrorFailsClosed(t *testing.T) {
	f := newChatFixture(t, true)
	app := testdb.Open(t)
	h := teams.NewHandler(teams.NewRepository(app.DB), auth.NewUserRepository(app.DB), closingPusher{app}, &fakeNotifier{}, f.store)
	buf, ct := multipartReq(t, "", map[string]string{"r.txt": "x"})
	req := httptest.NewRequest("POST", "/", buf)
	req.Header.Set("Content-Type", ct)
	rec := serveReq(t, h.PostMessage, req, f.as(f.member), map[string]string{"channel": f.general.String()})
	var m wireMsg
	if err := jsonDecode(rec, &m); rec.Code != 201 || err != nil || len(m.Attachments) != 1 {
		t.Fatalf("post: %d %s", rec.Code, rec.Body)
	}
	if a := m.Attachments[0]; a.Kind != "file" || !a.Deleted || a.Filename != "" {
		t.Fatalf("not redacted: %+v", a)
	}
	if n := f.countMessages(t, f.general); n != 1 {
		t.Fatalf("messages: %d", n)
	}
}
