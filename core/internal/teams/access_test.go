package teams_test

import (
	"context"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"core/internal/teams"

	"github.com/google/uuid"
)

// privFixture: a private channel "secret" listing f.member directly and f.staff through
// group "Ops"; unlisted is a plain team member; it holds one message with an attachment.
type privFixture struct {
	chatFixture
	secret, unlisted, group uuid.UUID
	msg, att                uuid.UUID
}

func newPrivFixture(t *testing.T) privFixture {
	t.Helper()
	f := privFixture{chatFixture: newChatFixture(t, true), unlisted: uuid.New()}
	ctx := context.Background()
	if _, err := f.app.DB.Exec(ctx, `INSERT INTO users (id, tenant_id, email, password_hash, kind) VALUES ($1,$2,$3,'x','staff')`,
		f.unlisted, f.tenant, f.unlisted.String()+"@t.test"); err != nil {
		t.Fatal(err)
	}
	for _, u := range []uuid.UUID{f.staff, f.unlisted} {
		if _, err := f.repo.AddMember(ctx, f.tenant, f.team, u, teams.RoleMember); err != nil {
			t.Fatal(err)
		}
	}
	ch, err := f.repo.CreateChannel(ctx, f.tenant, f.team, "secret")
	if err != nil {
		t.Fatal(err)
	}
	f.secret = ch.ID
	rec := serve(t, f.h.CreateGroup, "POST", `{"name":"Ops","user_ids":["`+f.staff.String()+`"]}`, f.as(f.owner), f.teamP())
	var g struct{ ID uuid.UUID }
	if err := jsonDecode(rec, &g); rec.Code != 201 || err != nil {
		t.Fatalf("group: %d %s", rec.Code, rec.Body)
	}
	f.group = g.ID
	rec = serve(t, f.h.PutChannelAccess, "PUT", `{"user_ids":["`+f.member.String()+`"],"group_ids":["`+f.group.String()+`"]}`,
		f.as(f.owner), f.chanP(f.secret))
	if rec.Code != 200 {
		t.Fatalf("access: %d %s", rec.Code, rec.Body)
	}
	buf, ct := multipartReq(t, "secret stuff", map[string]string{"s.txt": "classified"})
	req := httptest.NewRequest("POST", "/", buf)
	req.Header.Set("Content-Type", ct)
	rec = serveReq(t, f.h.PostMessage, req, f.as(f.member), map[string]string{"channel": f.secret.String()})
	var m struct {
		ID          uuid.UUID
		Attachments []struct{ ID uuid.UUID }
	}
	if err := jsonDecode(rec, &m); rec.Code != 201 || err != nil || len(m.Attachments) != 1 {
		t.Fatalf("post: %d %s", rec.Code, rec.Body)
	}
	f.msg, f.att = m.ID, m.Attachments[0].ID
	f.hub.frames, f.notes.sent = nil, nil
	return f
}

func (f privFixture) teamP() map[string]string { return map[string]string{"id": f.team.String()} }
func (f privFixture) chanP(ch uuid.UUID) map[string]string {
	return map[string]string{"id": f.team.String(), "channel": ch.String()}
}

type channelRow struct {
	ID      uuid.UUID
	Private bool
	Unread  int
}

func (f privFixture) channels(t *testing.T, as uuid.UUID) (int, []channelRow) {
	t.Helper()
	rec := serve(t, f.h.ListChannels, "GET", "", f.as(as), f.teamP())
	var out struct{ Data []channelRow }
	_ = jsonDecode(rec, &out)
	return rec.Code, out.Data
}

func (f privFixture) seesInList(t *testing.T, as uuid.UUID) (int, bool) {
	t.Helper()
	code, rows := f.channels(t, as)
	return code, slices.ContainsFunc(rows, func(r channelRow) bool { return r.ID == f.secret })
}

func TestPrivateChannel_Matrix(t *testing.T) {
	f := newPrivFixture(t)
	users := []struct {
		name    string
		id      uuid.UUID
		visible bool
	}{{"owner not listed", f.owner, true}, {"listed user", f.member, true}, {"via group", f.staff, true},
		{"unlisted member", f.unlisted, false}, {"outsider", f.outside, false}}
	ch := map[string]string{"channel": f.secret.String()}
	routes := []struct {
		name string
		ok   int
		call func(as uuid.UUID) int
	}{
		{"GET messages", 200, func(as uuid.UUID) int { return serve(t, f.h.ListMessages, "GET", "", f.as(as), ch).Code }},
		{"POST message", 201, func(as uuid.UUID) int {
			return serve(t, f.h.PostMessage, "POST", `{"body":"x"}`, f.as(as), ch).Code
		}},
		{"POST read", 204, func(as uuid.UUID) int { return serve(t, f.h.MarkRead, "POST", "", f.as(as), ch).Code }},
		{"reaction", 200, func(as uuid.UUID) int {
			return serve(t, f.h.ToggleReaction, "POST", `{"emoji":"👍"}`, f.as(as), map[string]string{"message": f.msg.String()}).Code
		}},
		{"attachment", 200, func(as uuid.UUID) int {
			return serve(t, f.h.GetAttachment, "GET", "", f.as(as), map[string]string{"id": f.att.String()}).Code
		}},
	}
	for _, u := range users {
		t.Run("list channels/"+u.name, func(t *testing.T) {
			code, sees := f.seesInList(t, u.id)
			if u.id == f.outside {
				if code != 404 {
					t.Fatalf("outsider list: %d", code)
				}
				return
			}
			if code != 200 || sees != u.visible {
				t.Fatalf("list: %d sees=%v", code, sees)
			}
		})
		for _, r := range routes {
			t.Run(r.name+"/"+u.name, func(t *testing.T) {
				want := 404
				if u.visible {
					want = r.ok
				}
				if got := r.call(u.id); got != want {
					t.Fatalf("got %d, want %d", got, want)
				}
			})
		}
	}
}

func TestPrivateChannel_FramesAndMentionsOnlyAudience(t *testing.T) {
	f := newPrivFixture(t)
	body := `{"body":"hi","mentions":["` + f.unlisted.String() + `","` + f.staff.String() + `","` + f.owner.String() + `"]}`
	f.post(t, f.member, f.secret, body)
	if len(f.hub.frames) != 1 || !sameSet(f.hub.frames[0].users, []uuid.UUID{f.owner, f.member, f.staff}) {
		t.Fatalf("frame audience: %+v", f.hub.frames)
	}
	var got []uuid.UUID
	for _, n := range f.notes.sent {
		got = append(got, n.user)
	}
	if !sameSet(got, []uuid.UUID{f.staff, f.owner}) {
		t.Fatalf("mentions: %v", got)
	}
	serve(t, f.h.ToggleReaction, "POST", `{"emoji":"👍"}`, f.as(f.owner), map[string]string{"message": f.msg.String()})
	if fr := f.hub.frames[len(f.hub.frames)-1]; !sameSet(fr.users, []uuid.UUID{f.owner, f.member, f.staff}) {
		t.Fatalf("reaction audience: %v", fr.users)
	}
}

func TestPrivateChannel_UnreadExcludedForUnlisted(t *testing.T) {
	f := newPrivFixture(t)
	teamUnread := func(as uuid.UUID) string {
		return serve(t, f.h.ListTeams, "GET", "", f.as(as), nil).Body.String()
	}
	if b := teamUnread(f.unlisted); !strings.Contains(b, `"unread":0`) {
		t.Fatalf("unlisted team unread: %s", b)
	}
	if b := teamUnread(f.staff); !strings.Contains(b, `"unread":1`) {
		t.Fatalf("staff team unread: %s", b)
	}
	if b := serve(t, f.h.GetTeam, "GET", "", f.as(f.unlisted), f.teamP()).Body.String(); !strings.Contains(b, `"unread":0`) {
		t.Fatalf("unlisted GET team: %s", b)
	}
	_, rows := f.channels(t, f.staff)
	for _, r := range rows {
		if r.ID == f.secret && (!r.Private || r.Unread != 1) {
			t.Fatalf("staff row: %+v", r)
		}
		if r.ID == f.general && r.Private {
			t.Fatalf("general is private")
		}
	}
}

func TestPrivateChannel_OrderRejectsInvisible(t *testing.T) {
	f := newPrivFixture(t)
	if rec := serve(t, f.h.SetChannelOrder, "PUT", ids(f.secret, f.general), f.as(f.unlisted), f.teamP()); rec.Code != 422 {
		t.Fatalf("unlisted order: %d", rec.Code)
	}
	if rec := serve(t, f.h.SetChannelOrder, "PUT", ids(f.secret, f.general), f.as(f.staff), f.teamP()); rec.Code != 204 {
		t.Fatalf("staff order: %d %s", rec.Code, rec.Body)
	}
}

func (f privFixture) count(t *testing.T, q string, args ...any) int {
	t.Helper()
	var n int
	if err := f.app.DB.QueryRow(context.Background(), q, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestRemoveMember_DropsGroupAndAccess(t *testing.T) {
	f := newPrivFixture(t)
	// owner removes the listed member; the group member leaves by themselves
	if rec := serve(t, f.h.RemoveMember, "DELETE", "", f.as(f.owner), map[string]string{"id": f.team.String(), "user": f.member.String()}); rec.Code != 204 {
		t.Fatalf("remove: %d", rec.Code)
	}
	if rec := serve(t, f.h.RemoveMember, "DELETE", "", f.as(f.staff), map[string]string{"id": f.team.String(), "user": f.staff.String()}); rec.Code != 204 {
		t.Fatalf("leave: %d", rec.Code)
	}
	if n := f.count(t, `SELECT count(*) FROM team_group_member WHERE group_id=$1`, f.group); n != 0 {
		t.Fatalf("group members left: %d", n)
	}
	if n := f.count(t, `SELECT count(*) FROM chat_channel_access WHERE channel_id=$1 AND user_id IS NOT NULL`, f.secret); n != 0 {
		t.Fatalf("user access rows left: %d", n)
	}
	f.post(t, f.owner, f.secret, `{"body":"anyone?"}`)
	if fr := f.hub.frames[len(f.hub.frames)-1]; !sameSet(fr.users, []uuid.UUID{f.owner}) {
		t.Fatalf("frame after removal: %v", fr.users)
	}
}

func TestGroups_CRUDOwnerOnly(t *testing.T) {
	f := newPrivFixture(t)
	gp := map[string]string{"id": f.team.String(), "group": f.group.String()}
	body := `{"name":"Devs","user_ids":["` + f.member.String() + `"]}`
	if rec := serve(t, f.h.CreateGroup, "POST", body, f.as(f.member), f.teamP()); rec.Code != 403 {
		t.Fatalf("member create: %d", rec.Code)
	}
	if rec := serve(t, f.h.CreateGroup, "POST", body, f.as(f.outside), f.teamP()); rec.Code != 404 {
		t.Fatalf("outsider create: %d", rec.Code)
	}
	if rec := serve(t, f.h.ListGroups, "GET", "", f.as(f.member), f.teamP()); rec.Code != 403 {
		t.Fatalf("member list: %d", rec.Code)
	}
	if rec := serve(t, f.h.CreateGroup, "POST", `{"name":"ops","user_ids":[]}`, f.as(f.owner), f.teamP()); rec.Code != 409 {
		t.Fatalf("duplicate name: %d %s", rec.Code, rec.Body)
	}
	if rec := serve(t, f.h.UpdateGroup, "PUT", body, f.as(f.member), gp); rec.Code != 403 {
		t.Fatalf("member update: %d", rec.Code)
	}
	rec := serve(t, f.h.UpdateGroup, "PUT", `{"name":"Ops 2","user_ids":["`+f.member.String()+`","`+f.unlisted.String()+`"]}`, f.as(f.owner), gp)
	var g struct {
		ID      uuid.UUID
		Name    string
		UserIDs []uuid.UUID `json:"user_ids"`
	}
	if err := jsonDecode(rec, &g); rec.Code != 200 || err != nil || g.Name != "Ops 2" || !sameSet(g.UserIDs, []uuid.UUID{f.member, f.unlisted}) {
		t.Fatalf("update: %d %s", rec.Code, rec.Body)
	}
	if _, sees := f.seesInList(t, f.unlisted); !sees {
		t.Fatal("unlisted should now see secret through the group")
	}
	rec = serve(t, f.h.ListGroups, "GET", "", f.as(f.owner), f.teamP())
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"name":"Ops 2"`) {
		t.Fatalf("list: %d %s", rec.Code, rec.Body)
	}
	if rec := serve(t, f.h.UpdateGroup, "PUT", body, f.as(f.owner), map[string]string{"id": f.team.String(), "group": uuid.NewString()}); rec.Code != 404 {
		t.Fatalf("unknown group: %d", rec.Code)
	}
	if rec := serve(t, f.h.DeleteGroup, "DELETE", "", f.as(f.member), gp); rec.Code != 403 {
		t.Fatalf("member delete: %d", rec.Code)
	}
	if rec := serve(t, f.h.DeleteGroup, "DELETE", "", f.as(f.owner), gp); rec.Code != 204 {
		t.Fatalf("delete: %d", rec.Code)
	}
	if n := f.count(t, `SELECT count(*) FROM chat_channel_access WHERE group_id=$1`, f.group); n != 0 {
		t.Fatalf("group access rows left: %d", n)
	}
	if rec := serve(t, f.h.DeleteGroup, "DELETE", "", f.as(f.owner), gp); rec.Code != 404 {
		t.Fatalf("delete twice: %d", rec.Code)
	}
}

func TestGroups_NonMember422(t *testing.T) {
	f := newPrivFixture(t)
	bad := `{"name":"X","user_ids":["` + f.outside.String() + `"]}`
	if rec := serve(t, f.h.CreateGroup, "POST", bad, f.as(f.owner), f.teamP()); rec.Code != 422 {
		t.Fatalf("create: %d", rec.Code)
	}
	if rec := serve(t, f.h.UpdateGroup, "PUT", bad, f.as(f.owner), map[string]string{"id": f.team.String(), "group": f.group.String()}); rec.Code != 422 {
		t.Fatalf("update: %d", rec.Code)
	}
	if rec := serve(t, f.h.CreateGroup, "POST", `{"name":"  ","user_ids":[]}`, f.as(f.owner), f.teamP()); rec.Code != 422 {
		t.Fatalf("blank name: %d", rec.Code)
	}
}

func TestAccess_ReplaceAndOpen(t *testing.T) {
	f := newPrivFixture(t)
	cp := f.chanP(f.secret)
	rec := serve(t, f.h.GetChannelAccess, "GET", "", f.as(f.owner), cp)
	var acc struct {
		UserIDs  []uuid.UUID `json:"user_ids"`
		GroupIDs []uuid.UUID `json:"group_ids"`
	}
	if err := jsonDecode(rec, &acc); rec.Code != 200 || err != nil || !sameSet(acc.UserIDs, []uuid.UUID{f.member}) || !sameSet(acc.GroupIDs, []uuid.UUID{f.group}) {
		t.Fatalf("get: %d %s", rec.Code, rec.Body)
	}
	if rec := serve(t, f.h.GetChannelAccess, "GET", "", f.as(f.member), cp); rec.Code != 403 {
		t.Fatalf("member get: %d", rec.Code)
	}
	for name, body := range map[string]string{
		"outside user":  `{"user_ids":["` + f.outside.String() + `"],"group_ids":[]}`,
		"unknown group": `{"user_ids":[],"group_ids":["` + uuid.NewString() + `"]}`,
	} {
		if rec := serve(t, f.h.PutChannelAccess, "PUT", body, f.as(f.owner), cp); rec.Code != 422 {
			t.Fatalf("%s: %d", name, rec.Code)
		}
	}
	if rec := serve(t, f.h.PutChannelAccess, "PUT", `{"user_ids":[]}`, f.as(f.owner), f.chanP(uuid.New())); rec.Code != 404 {
		t.Fatalf("unknown channel: %d", rec.Code)
	}
	// replace: only unlisted now
	rec = serve(t, f.h.PutChannelAccess, "PUT", `{"user_ids":["`+f.unlisted.String()+`"],"group_ids":[]}`, f.as(f.owner), cp)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), f.unlisted.String()) {
		t.Fatalf("replace: %d %s", rec.Code, rec.Body)
	}
	if _, sees := f.seesInList(t, f.member); sees {
		t.Fatal("member still sees after replace")
	}
	if _, sees := f.seesInList(t, f.unlisted); !sees {
		t.Fatal("unlisted doesn't see after replace")
	}
	// an empty list reopens the channel to the whole team
	rec = serve(t, f.h.PutChannelAccess, "PUT", `{"user_ids":[],"group_ids":[]}`, f.as(f.owner), cp)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"user_ids":[]`) {
		t.Fatalf("open: %d %s", rec.Code, rec.Body)
	}
	for _, u := range []uuid.UUID{f.member, f.guest, f.unlisted} {
		if _, sees := f.seesInList(t, u); !sees {
			t.Fatalf("%s doesn't see the reopened channel", u)
		}
	}
	_, rows := f.channels(t, f.member)
	for _, r := range rows {
		if r.Private {
			t.Fatalf("still private: %+v", r)
		}
	}
}
