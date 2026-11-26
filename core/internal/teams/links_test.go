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
