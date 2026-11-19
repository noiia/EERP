package teams_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func ids(ss ...uuid.UUID) string {
	b, _ := json.Marshal(map[string]any{"ids": ss})
	return string(b)
}

func channelNames(t *testing.T, f chatFixture, as uuid.UUID) []string {
	t.Helper()
	rec := serve(t, f.h.ListChannels, "GET", "", f.as(as), map[string]string{"id": f.team.String()})
	var out struct{ Data []struct{ Name string } }
	if err := jsonDecode(rec, &out); err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, c := range out.Data {
		names = append(names, c.Name)
	}
	return names
}

func TestChannelOrder_PerUser(t *testing.T) {
	f := newChatFixture(t, false)
	ctx := context.Background()
	a, _ := f.repo.CreateChannel(ctx, f.tenant, f.team, "alpha")
	b, _ := f.repo.CreateChannel(ctx, f.tenant, f.team, "beta")
	p := map[string]string{"id": f.team.String()}
	rec := serve(t, f.h.SetChannelOrder, "PUT", ids(b.ID, f.general, a.ID), f.as(f.owner), p)
	if rec.Code != 204 {
		t.Fatalf("order: %d %s", rec.Code, rec.Body)
	}
	if got := channelNames(t, f, f.owner); len(got) != 3 || got[0] != "beta" || got[1] != "general" || got[2] != "alpha" {
		t.Fatalf("owner order: %v", got)
	}
	if got := channelNames(t, f, f.member); got[0] != "alpha" || got[1] != "beta" || got[2] != "general" {
		t.Fatalf("member order: %v", got)
	}
}

func TestChannelOrder_UnknownId422(t *testing.T) {
	f := newChatFixture(t, false)
	p := map[string]string{"id": f.team.String()}
	if rec := serve(t, f.h.SetChannelOrder, "PUT", ids(f.general, uuid.New()), f.as(f.owner), p); rec.Code != 422 {
		t.Fatalf("unknown: %d", rec.Code)
	}
	if rec := serve(t, f.h.SetChannelOrder, "PUT", ids(f.general), f.as(f.outside), p); rec.Code != 404 {
		t.Fatalf("outsider: %d", rec.Code)
	}
}

func TestDirectOrder_OnlyOwnConversations(t *testing.T) {
	f := newChatFixture(t, false)
	_, mine := direct(t, f, f.owner, f.staff)
	cleanupDirect(t, f, mine)
	_, other := direct(t, f, f.member, f.staff)
	cleanupDirect(t, f, other)
	if rec := serve(t, f.h.SetDirectOrder, "PUT", ids(other), f.as(f.owner), nil); rec.Code != 422 {
		t.Fatalf("foreign: %d", rec.Code)
	}
	if rec := serve(t, f.h.SetDirectOrder, "PUT", ids(mine), f.as(f.owner), nil); rec.Code != 204 {
		t.Fatalf("own: %d %s", rec.Code, rec.Body)
	}
	var pos *int
	_ = f.app.DB.QueryRow(context.Background(), `SELECT position FROM chat_channel_member WHERE channel_id=$1 AND user_id=$2`, mine, f.owner).Scan(&pos)
	if pos == nil || *pos != 0 {
		t.Fatalf("position: %v", pos)
	}
}

func TestMembers_HasAvatar(t *testing.T) {
	f := newChatFixture(t, false)
	if _, err := f.app.DB.Exec(context.Background(), `UPDATE users SET avatar=true WHERE id=$1`, f.member); err != nil {
		t.Fatal(err)
	}
	rec := serve(t, f.h.ListMembers, "GET", "", f.as(f.owner), map[string]string{"id": f.team.String()})
	var out struct {
		Data []struct {
			UserID    uuid.UUID `json:"user_id"`
			HasAvatar bool      `json:"has_avatar"`
		}
	}
	if err := jsonDecode(rec, &out); err != nil {
		t.Fatal(err)
	}
	for _, m := range out.Data {
		if m.HasAvatar != (m.UserID == f.member) {
			t.Fatalf("has_avatar wrong for %s: %v", m.UserID, m.HasAvatar)
		}
	}
	m := f.post(t, f.member, f.general, `{"body":"hi"}`)
	if m["author_has_avatar"] != true {
		t.Fatalf("author_has_avatar: %v", m)
	}
	rec = serve(t, f.h.Directory, "GET", "", f.as(f.owner), nil)
	if !json.Valid(rec.Body.Bytes()) || !strings.Contains(rec.Body.String(), `"has_avatar":true`) {
		t.Fatalf("directory: %s", rec.Body)
	}
}
