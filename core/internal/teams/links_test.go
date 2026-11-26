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

// newLink uploads content as f.member and creates a link to it; returns the file id and token.
func (f chatFixture) newLink(t *testing.T, folder, content string) (uuid.UUID, string) {
	t.Helper()
	code, file := f.upload(t, f.member, folder, "doc.txt", content)
	if code != 201 {
		t.Fatalf("upload: %d", code)
	}
	rec := serve(t, f.h.CreateLink, "POST", linkBody(time.Now().Add(time.Hour)), f.as(f.member), map[string]string{"file": file.String()})
	var out struct{ Token string }
	if err := jsonDecode(rec, &out); err != nil || rec.Code != 201 {
		t.Fatalf("create link: %d %s", rec.Code, rec.Body)
	}
	return file, out.Token
}

func TestDownloadLink_AnyStaffOfTenant(t *testing.T) {
	f := newChatFixture(t, true)
	_, token := f.newLink(t, "", "hello")
	rec := serve(t, f.h.DownloadLink, "GET", "", f.as(f.staff), map[string]string{"token": token}) // not a team member
	if rec.Code != 200 || rec.Body.String() != "hello" {
		t.Fatalf("download: %d %s", rec.Code, rec.Body)
	}
	h := rec.Header()
	if h.Get("Cache-Control") != "private, no-store" || h.Get("X-Content-Type-Options") != "nosniff" ||
		h.Get("Content-Disposition") != `attachment; filename=doc.txt` || h.Get("ETag") == "" {
		t.Fatalf("headers: %v", h)
	}
	l, err := f.repo.ResolveLink(context.Background(), teams.HashToken(token))
	if err != nil || l.DownloadCount != 1 {
		t.Fatalf("count: %+v %v", l, err)
	}
}

func TestDownloadLink_404s(t *testing.T) {
	ctx := context.Background()
	for _, tc := range []struct {
		name  string
		mutate func(t *testing.T, f chatFixture, file uuid.UUID, token string) (caller uuidOrTenant, tok string)
	}{
		{"unknown token", func(t *testing.T, f chatFixture, _ uuid.UUID, _ string) (uuidOrTenant, string) {
			return uuidOrTenant{user: f.staff}, "nope"
		}},
		{"revoked", func(t *testing.T, f chatFixture, _ uuid.UUID, tok string) (uuidOrTenant, string) {
			l, _ := f.repo.ResolveLink(ctx, teams.HashToken(tok))
			_ = f.repo.RevokeLink(ctx, f.tenant, l.ID)
			return uuidOrTenant{user: f.staff}, tok
		}},
		{"expired", func(t *testing.T, f chatFixture, _ uuid.UUID, tok string) (uuidOrTenant, string) {
			_, _ = f.app.DB.Exec(ctx, `UPDATE team_file_link SET expires_at=now()-interval '1 minute' WHERE token_hash=$1`, teams.HashToken(tok))
			return uuidOrTenant{user: f.staff}, tok
		}},
		{"file deleted", func(t *testing.T, f chatFixture, file uuid.UUID, tok string) (uuidOrTenant, string) {
			_, _ = f.repo.DeleteFile(ctx, f.tenant, file)
			return uuidOrTenant{user: f.staff}, tok
		}},
		{"other tenant", func(t *testing.T, f chatFixture, _ uuid.UUID, tok string) (uuidOrTenant, string) {
			return uuidOrTenant{user: uuid.New(), tenant: uuid.New()}, tok
		}},
		{"creator deleted", func(t *testing.T, f chatFixture, _ uuid.UUID, tok string) (uuidOrTenant, string) {
			if _, err := f.app.DB.Exec(ctx, `UPDATE users SET deleted_at=now() WHERE id=$1`, f.member); err != nil {
				t.Fatal(err)
			}
			return uuidOrTenant{user: f.staff}, tok
		}},
		{"creator removed from team", func(t *testing.T, f chatFixture, _ uuid.UUID, tok string) (uuidOrTenant, string) {
			if err := f.repo.RemoveMember(ctx, f.tenant, f.team, f.member); err != nil {
				t.Fatal(err)
			}
			return uuidOrTenant{user: f.staff}, tok
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newChatFixture(t, true)
			file, token := f.newLink(t, "", "x")
			who, tok := tc.mutate(t, f, file, token)
			id := f.as(who.user)
			if who.tenant != uuid.Nil {
				id.TenantID = who.tenant
			}
			rec := serve(t, f.h.DownloadLink, "GET", "", id, map[string]string{"token": tok})
			if rec.Code != 404 {
				t.Fatalf("got %d %s", rec.Code, rec.Body)
			}
		})
	}
}

type uuidOrTenant struct{ user, tenant uuid.UUID }

func TestDownloadLink_CreatorLostPrivateFolder(t *testing.T) {
	f := newChatFixture(t, true)
	folder := f.folder(t, f.owner, f.team, `{"name":"private"}`)
	_, token := f.newLink(t, folder.String(), "secret")
	rec := serve(t, f.h.CreateChannel, "POST", `{"name":"hush"}`, f.as(f.owner), map[string]string{"id": f.team.String()})
	var ch struct{ ID uuid.UUID }
	if err := jsonDecode(rec, &ch); err != nil || rec.Code != 201 {
		t.Fatalf("channel: %d %s", rec.Code, rec.Body)
	}
	cp := map[string]string{"id": f.team.String(), "channel": ch.ID.String()}
	if c := f.call(t, f.h.RenameChannel, "PUT", `{"folder_id":"`+folder.String()+`"}`, f.owner, cp); c != 200 {
		t.Fatalf("link folder: %d", c)
	}
	if c := f.call(t, f.h.PutChannelAccess, "PUT", `{"user_ids":["`+f.guest.String()+`"],"group_ids":[]}`, f.owner, cp); c != 200 {
		t.Fatalf("restrict: %d", c)
	}
	if rec := serve(t, f.h.DownloadLink, "GET", "", f.as(f.staff), map[string]string{"token": token}); rec.Code != 404 {
		t.Fatalf("got %d", rec.Code)
	}
}

func TestDownloadLink_ServesLatestContent(t *testing.T) {
	f := newChatFixture(t, true)
	ctx := context.Background()
	fileID, token := f.newLink(t, "", "v1")
	file, err := f.repo.FindFile(ctx, f.tenant, fileID)
	if err != nil {
		t.Fatal(err)
	}
	f.store.objs["new-key"] = []byte("v2")
	if ok, err := f.repo.ReplaceFileContent(ctx, teams.File{TenantID: f.tenant, ObjectKey: "new-key", Mime: file.Mime, Size: 2,
		BaseModel: file.BaseModel}, file.ObjectKey); err != nil || !ok {
		t.Fatalf("replace: %v %v", ok, err)
	}
	rec := serve(t, f.h.DownloadLink, "GET", "", f.as(f.staff), map[string]string{"token": token})
	if rec.Code != 200 || rec.Body.String() != "v2" {
		t.Fatalf("got %d %s", rec.Code, rec.Body)
	}
}
