package teams_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"core/internal/teams"
	"core/orm"

	"github.com/google/uuid"
)

func (f chatFixture) file(t *testing.T, team uuid.UUID, folder *uuid.UUID, name string) teams.File {
	t.Helper()
	file, err := f.repo.CreateFile(context.Background(), teams.File{TenantID: f.tenant, TeamID: team, FolderID: folder,
		Name: name, Mime: "text/plain", Size: 1, ObjectKey: uuid.NewString(), UploadedBy: f.member})
	if err != nil {
		t.Fatal(err)
	}
	return file
}

func (f chatFixture) link(t *testing.T, file teams.File, token string, expires time.Time) teams.Link {
	t.Helper()
	l, err := f.repo.CreateLink(context.Background(), teams.Link{TenantID: f.tenant, TeamID: file.TeamID, FileID: file.ID,
		CreatedBy: f.member, TokenHash: teams.HashToken(token), ExpiresAt: expires})
	if err != nil {
		t.Fatal(err)
	}
	return l
}

func TestLinks_CreateResolveRevoke(t *testing.T) {
	f := newChatFixture(t, true)
	ctx := context.Background()
	l := f.link(t, f.file(t, f.team, nil, "a.txt"), "tok-"+uuid.NewString(), time.Now().Add(time.Hour))
	got, err := f.repo.ResolveLink(ctx, l.TokenHash)
	if err != nil || got.ID != l.ID {
		t.Fatalf("resolve: %+v %v", got, err)
	}
	if err := f.repo.RevokeLink(ctx, f.tenant, l.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.repo.ResolveLink(ctx, l.TokenHash); !errors.Is(err, orm.ErrNotFound) {
		t.Fatalf("revoked link resolved: %v", err)
	}
}

func TestLinks_ExpiredNotResolved(t *testing.T) {
	f := newChatFixture(t, true)
	ctx := context.Background()
	file := f.file(t, f.team, nil, "a.txt")
	l := f.link(t, file, "tok-"+uuid.NewString(), time.Now().Add(-time.Minute))
	if _, err := f.repo.ResolveLink(ctx, l.TokenHash); !errors.Is(err, orm.ErrNotFound) {
		t.Fatalf("expired link resolved: %v", err)
	}
	if ls, err := f.repo.ListLinks(ctx, f.tenant, file.ID); err != nil || len(ls) != 0 {
		t.Fatalf("list: %v %v", ls, err)
	}
}

func TestLinks_DeletedWithFileFolderTeam(t *testing.T) {
	f := newChatFixture(t, true)
	ctx := context.Background()
	exp := time.Now().Add(time.Hour)
	root := f.link(t, f.file(t, f.team, nil, "root.txt"), "a-"+uuid.NewString(), exp)
	folder := f.folder(t, f.owner, f.team, `{"name":"d"}`)
	inFolder := f.link(t, f.file(t, f.team, &folder, "in.txt"), "b-"+uuid.NewString(), exp)
	other, _, err := f.repo.CreateTeam(ctx, teams.Team{TenantID: f.tenant, Name: "Other"}, f.owner)
	if err != nil {
		t.Fatal(err)
	}
	inTeam := f.link(t, f.file(t, other.ID, nil, "t.txt"), "c-"+uuid.NewString(), exp)

	if _, err := f.repo.DeleteFile(ctx, f.tenant, root.FileID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.repo.DeleteFolderTree(ctx, f.tenant, folder); err != nil {
		t.Fatal(err)
	}
	if _, err := f.repo.DeleteTeam(ctx, f.tenant, other.ID); err != nil {
		t.Fatal(err)
	}
	for _, l := range []teams.Link{root, inFolder, inTeam} {
		var n int
		if err := f.app.DB.QueryRow(ctx, `SELECT count(*) FROM team_file_link WHERE id=$1`, l.ID).Scan(&n); err != nil || n != 0 {
			t.Fatalf("link %s left behind: %d %v", l.ID, n, err)
		}
	}
}

func TestLinks_CountDownload(t *testing.T) {
	f := newChatFixture(t, true)
	ctx := context.Background()
	l := f.link(t, f.file(t, f.team, nil, "a.txt"), "tok-"+uuid.NewString(), time.Now().Add(time.Hour))
	for range 2 {
		if err := f.repo.CountDownload(ctx, f.tenant, l.ID); err != nil {
			t.Fatal(err)
		}
	}
	got, err := f.repo.FindLink(ctx, f.tenant, l.ID)
	if err != nil || got.DownloadCount != 2 || got.LastDownloadAt == nil {
		t.Fatalf("count: %+v %v", got, err)
	}
}

func linkBody(at time.Time) string { return `{"expires_at":"` + at.UTC().Format(time.RFC3339) + `"}` }

func TestLinkRoutes_ManagerRule(t *testing.T) {
	f := newChatFixture(t, true)
	file := f.file(t, f.team, nil, "m.txt") // uploaded by f.member
	p := map[string]string{"file": file.ID.String()}
	body := linkBody(time.Now().Add(24 * time.Hour))
	for _, tc := range []struct {
		name string
		as   uuid.UUID
		want int
	}{{"uploader", f.member, 201}, {"owner", f.owner, 201}, {"guest", f.guest, 403}, {"non-member", f.outside, 404}} {
		t.Run(tc.name, func(t *testing.T) {
			if c := f.call(t, f.h.CreateLink, "POST", body, tc.as, p); c != tc.want {
				t.Fatalf("got %d want %d", c, tc.want)
			}
		})
	}
	other := f.guest2(t) // promoted to member, not the uploader
	if c := f.call(t, f.h.CreateLink, "POST", body, other, p); c != 403 {
		t.Fatalf("other member: %d", c)
	}
}

func TestLinkRoutes_ExpiryBounds(t *testing.T) {
	f := newChatFixture(t, true)
	file := f.file(t, f.team, nil, "m.txt")
	p := map[string]string{"file": file.ID.String()}
	now := time.Now()
	for _, tc := range []struct {
		name, body string
		want       int
	}{
		{"past", linkBody(now.Add(-time.Minute)), 422},
		{"now", linkBody(now), 422},
		{"over 90 days", linkBody(now.Add(90*24*time.Hour + time.Minute)), 422},
		{"malformed", `{"expires_at":"soon"}`, 400},
		{"missing", `{}`, 422},
		{"7 days", linkBody(now.Add(7 * 24 * time.Hour)), 201},
		{"just under 90 days", linkBody(now.Add(90*24*time.Hour - time.Minute)), 201},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if c := f.call(t, f.h.CreateLink, "POST", tc.body, f.member, p); c != tc.want {
				t.Fatalf("got %d want %d", c, tc.want)
			}
		})
	}
}

func TestLinkRoutes_ListAndRevoke(t *testing.T) {
	f := newChatFixture(t, true)
	file := f.file(t, f.team, nil, "m.txt")
	p := map[string]string{"file": file.ID.String()}
	body := linkBody(time.Now().Add(time.Hour))
	rec := serve(t, f.h.CreateLink, "POST", body, f.as(f.member), p)
	var created struct {
		ID, Token, URL string
	}
	if err := jsonDecode(rec, &created); err != nil || rec.Code != 201 || created.Token == "" || created.URL != "/app/teams/links/"+created.Token {
		t.Fatalf("create: %d %s", rec.Code, rec.Body)
	}
	if _, err := f.repo.ResolveLink(context.Background(), teams.HashToken(created.Token)); err != nil {
		t.Fatalf("token does not resolve: %v", err)
	}
	f.call(t, f.h.CreateLink, "POST", body, f.member, p)
	rec = serve(t, f.h.ListLinks, "GET", "", f.as(f.guest), p) // managers only
	if rec.Code != 403 {
		t.Fatalf("guest list: %d", rec.Code)
	}
	rec = serve(t, f.h.ListLinks, "GET", "", f.as(f.member), p)
	var listed struct {
		Data []map[string]any
	}
	if err := jsonDecode(rec, &listed); err != nil || rec.Code != 200 || len(listed.Data) != 2 {
		t.Fatalf("list: %d %s", rec.Code, rec.Body)
	}
	if _, has := listed.Data[0]["token"]; has {
		t.Fatal("list must never return a token")
	}
	lp := map[string]string{"link": created.ID}
	if c := f.call(t, f.h.RevokeLink, "DELETE", "", f.guest, lp); c != 403 {
		t.Fatalf("guest revoke: %d", c)
	}
	if c := f.call(t, f.h.RevokeLink, "DELETE", "", f.outside, lp); c != 404 {
		t.Fatalf("outsider revoke: %d", c)
	}
	if c := f.call(t, f.h.RevokeLink, "DELETE", "", f.member, lp); c != 204 {
		t.Fatalf("revoke: %d", c)
	}
	rec = serve(t, f.h.ListLinks, "GET", "", f.as(f.member), p)
	_ = jsonDecode(rec, &listed)
	if len(listed.Data) != 1 {
		t.Fatalf("after revoke: %s", rec.Body)
	}
}
