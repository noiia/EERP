package teams_test

import (
	"context"
	"net/http/httptest"
	"sync"
	"testing"

	"core/internal/teams"

	"github.com/google/uuid"
)

type wireAtt struct {
	ID       uuid.UUID
	Kind     string
	Filename string
	Deleted  bool
}

type wireMsg struct {
	ID          uuid.UUID
	Attachments []wireAtt
}

// sendFile posts a multipart message carrying one file into channel.
func (f chatFixture) sendFile(t *testing.T, as, channel uuid.UUID, name, content string) (int, wireMsg) {
	t.Helper()
	buf, ct := multipartReq(t, "", map[string]string{name: content})
	req := httptest.NewRequest("POST", "/", buf)
	req.Header.Set("Content-Type", ct)
	rec := serveReq(t, f.h.PostMessage, req, f.as(as), map[string]string{"channel": channel.String()})
	var m wireMsg
	_ = jsonDecode(rec, &m)
	return rec.Code, m
}

func (f chatFixture) linked(t *testing.T, channel uuid.UUID) *uuid.UUID {
	t.Helper()
	ch, err := f.repo.FindChannel(context.Background(), f.tenant, channel)
	if err != nil {
		t.Fatal(err)
	}
	return ch.FolderID
}

func (f chatFixture) countRows(t *testing.T, q string, args ...any) int {
	t.Helper()
	var n int
	if err := f.app.DB.QueryRow(context.Background(), q, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func (f chatFixture) chanP(ch uuid.UUID) map[string]string {
	return map[string]string{"id": f.team.String(), "channel": ch.String()}
}

func TestLinkFolder_OwnerOnlyAndUnique(t *testing.T) {
	f := newChatFixture(t, true)
	ctx := context.Background()
	a := f.folder(t, f.owner, f.team, `{"name":"A"}`)
	body := `{"folder_id":"` + a.String() + `"}`
	if c := f.call(t, f.h.RenameChannel, "PUT", body, f.member, f.chanP(f.general)); c != 403 {
		t.Fatalf("member link: %d", c)
	}
	rec := serve(t, f.h.RenameChannel, "PUT", body, f.as(f.owner), f.chanP(f.general))
	var out struct {
		Name     string
		FolderID *uuid.UUID `json:"folder_id"`
	}
	if err := jsonDecode(rec, &out); rec.Code != 200 || err != nil || out.FolderID == nil || *out.FolderID != a || out.Name != "general" {
		t.Fatalf("owner link: %d %s", rec.Code, rec.Body)
	}
	other, err := f.repo.CreateChannel(ctx, f.tenant, f.team, "other")
	if err != nil {
		t.Fatal(err)
	}
	if c := f.call(t, f.h.RenameChannel, "PUT", body, f.owner, f.chanP(other.ID)); c != 422 {
		t.Fatalf("linked elsewhere: %d", c)
	}
	team2, _, err := f.repo.CreateTeam(ctx, teams.Team{TenantID: f.tenant, Name: "T2"}, f.owner)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = f.repo.DeleteTeam(ctx, f.tenant, team2.ID) })
	foreign, err := f.repo.CreateFolder(ctx, teams.Folder{TenantID: f.tenant, TeamID: team2.ID, Name: "F", CreatedBy: f.owner})
	if err != nil {
		t.Fatal(err)
	}
	if c := f.call(t, f.h.RenameChannel, "PUT", `{"folder_id":"`+foreign.ID.String()+`"}`, f.owner, f.chanP(other.ID)); c != 422 {
		t.Fatalf("foreign folder: %d", c)
	}
	rec = serve(t, f.h.RenameChannel, "PUT", `{"folder_id":""}`, f.as(f.owner), f.chanP(f.general))
	out.FolderID = &a
	if err := jsonDecode(rec, &out); rec.Code != 200 || err != nil || out.FolderID != nil {
		t.Fatalf("unlink: %d %s", rec.Code, rec.Body)
	}
	// a rename alone keeps working and leaves the link alone
	if c := f.call(t, f.h.RenameChannel, "PUT", body, f.owner, f.chanP(other.ID)); c != 200 {
		t.Fatalf("relink: %d", c)
	}
	if c := f.call(t, f.h.RenameChannel, "PUT", `{"name":"renamed"}`, f.owner, f.chanP(other.ID)); c != 200 || f.linked(t, other.ID) == nil {
		t.Fatalf("rename dropped link: %d", c)
	}
}

func TestSendFiles_CreatesAndLinksFolder(t *testing.T) {
	f := newChatFixture(t, true)
	code, m := f.sendFile(t, f.member, f.general, "notes.txt", "hello file")
	if code != 201 || len(m.Attachments) != 1 || m.Attachments[0].Kind != "file" || m.Attachments[0].Filename != "notes.txt" {
		t.Fatalf("send: %d %+v", code, m)
	}
	folder := f.linked(t, f.general)
	if folder == nil {
		t.Fatal("no linked folder")
	}
	fo, err := f.repo.FindFolder(context.Background(), f.tenant, *folder)
	if err != nil || fo.Name != "general" || fo.ParentID != nil || fo.CreatedBy != f.member {
		t.Fatalf("folder: %+v %v", fo, err)
	}
	file, err := f.repo.FindFile(context.Background(), f.tenant, m.Attachments[0].ID)
	if err != nil || file.FolderID == nil || *file.FolderID != *folder || file.UploadedBy != f.member {
		t.Fatalf("file: %+v %v", file, err)
	}
	rec := serve(t, f.h.DownloadFile, "GET", "", f.as(f.guest), map[string]string{"file": file.ID.String()})
	if rec.Code != 200 || rec.Body.String() != "hello file" {
		t.Fatalf("download: %d %s", rec.Code, rec.Body)
	}
}

func TestSendFiles_NameCollisionSuffix(t *testing.T) {
	f := newChatFixture(t, true)
	f.folder(t, f.owner, f.team, `{"name":"general"}`)
	f.folder(t, f.owner, f.team, `{"name":"general (2)"}`)
	if code, _ := f.sendFile(t, f.member, f.general, "a.txt", "x"); code != 201 {
		t.Fatalf("send: %d", code)
	}
	fo, err := f.repo.FindFolder(context.Background(), f.tenant, *f.linked(t, f.general))
	if err != nil || fo.Name != "general (3)" {
		t.Fatalf("folder: %+v %v", fo, err)
	}
}

func TestSendFiles_ConcurrentOneFolder(t *testing.T) {
	f := newChatFixture(t, true)
	var wg sync.WaitGroup
	codes := make([]int, 2)
	for i := range codes {
		wg.Add(1)
		go func() {
			defer wg.Done()
			codes[i], _ = f.sendFile(t, f.member, f.general, "c.txt", "x")
		}()
	}
	wg.Wait()
	if codes[0] != 201 || codes[1] != 201 {
		t.Fatalf("codes: %v", codes)
	}
	if n := f.countRows(t, `SELECT count(*) FROM team_folder WHERE team_id=$1`, f.team); n != 1 {
		t.Fatalf("folders: %d", n)
	}
	if n := f.countRows(t, `SELECT count(*) FROM team_file WHERE team_id=$1`, f.team); n != 2 {
		t.Fatalf("files: %d", n)
	}
}

func TestSendFiles_UsesLinkedFolder(t *testing.T) {
	f := newChatFixture(t, true)
	x := f.folder(t, f.owner, f.team, `{"name":"X"}`)
	if c := f.call(t, f.h.RenameChannel, "PUT", `{"folder_id":"`+x.String()+`"}`, f.owner, f.chanP(f.general)); c != 200 {
		t.Fatalf("link: %d", c)
	}
	_, m := f.sendFile(t, f.member, f.general, "a.txt", "x")
	file, err := f.repo.FindFile(context.Background(), f.tenant, m.Attachments[0].ID)
	if err != nil || file.FolderID == nil || *file.FolderID != x {
		t.Fatalf("file: %+v %v", file, err)
	}
	if n := f.countRows(t, `SELECT count(*) FROM team_folder WHERE team_id=$1`, f.team); n != 1 {
		t.Fatalf("folders: %d", n)
	}
}

func TestDirectStillAttachments(t *testing.T) {
	f := newChatFixture(t, true)
	code, d := direct(t, f, f.member, f.owner)
	if code != 200 {
		t.Fatalf("direct: %d", code)
	}
	cleanupDirect(t, f, d)
	code, m := f.sendFile(t, f.member, d, "d.txt", "dm")
	if code != 201 || len(m.Attachments) != 1 || m.Attachments[0].Kind != "attachment" {
		t.Fatalf("send: %d %+v", code, m)
	}
	t.Cleanup(func() {
		_, _ = f.app.DB.Exec(context.Background(), `DELETE FROM chat_attachment WHERE message_id=$1`, m.ID)
	})
	if rec := serve(t, f.h.GetAttachment, "GET", "", f.as(f.owner), map[string]string{"id": m.Attachments[0].ID.String()}); rec.Code != 200 {
		t.Fatalf("download: %d", rec.Code)
	}
	if n := f.countRows(t, `SELECT count(*) FROM team_file WHERE tenant_id=$1`, f.tenant); n != 0 {
		t.Fatalf("team files: %d", n)
	}
}

func TestRestrictedFolder_Matrix(t *testing.T) {
	f := newPrivFixture(t) // f.att is s.txt, sent into the private channel's auto folder
	secret := f.linked(t, f.secret)
	if secret == nil {
		t.Fatal("private channel has no folder")
	}
	sub := f.folder(t, f.member, f.team, `{"name":"sub","parent_id":"`+secret.String()+`"}`)
	_, own := f.upload(t, f.unlisted, "", "own.txt", "mine")
	type listing struct {
		Folders []struct{ ID uuid.UUID }
		Files   []struct{ ID uuid.UUID }
	}
	sees := func(as uuid.UUID) bool {
		rec := serve(t, f.h.ListFiles, "GET", "", f.as(as), f.teamP())
		var l listing
		if err := jsonDecode(rec, &l); rec.Code != 200 || err != nil {
			t.Fatalf("root list: %d %s", rec.Code, rec.Body)
		}
		for _, fo := range l.Folders {
			if fo.ID == *secret {
				return true
			}
		}
		return false
	}
	list := func(as, folder uuid.UUID) int {
		req := httptest.NewRequest("GET", "/?folder="+folder.String(), nil)
		return serveReq(t, f.h.ListFiles, req, f.as(as), f.teamP()).Code
	}
	download := func(as uuid.UUID) int {
		return serve(t, f.h.DownloadFile, "GET", "", f.as(as), map[string]string{"file": f.att.String()}).Code
	}
	for _, u := range []struct {
		name    string
		id      uuid.UUID
		visible bool
	}{{"owner", f.owner, true}, {"listed", f.member, true}, {"via group", f.staff, true}, {"unlisted", f.unlisted, false}} {
		t.Run(u.name, func(t *testing.T) {
			want := map[bool]int{true: 200, false: 404}[u.visible]
			if sees(u.id) != u.visible {
				t.Fatalf("root listing visibility != %v", u.visible)
			}
			if c := list(u.id, *secret); c != want {
				t.Fatalf("?folder=secret: %d", c)
			}
			if c := list(u.id, sub); c != want {
				t.Fatalf("?folder=sub: %d", c)
			}
			if c := download(u.id); c != want {
				t.Fatalf("download: %d", c)
			}
		})
	}
	p := map[string]string{"id": f.team.String(), "file": own.String()}
	if c := f.call(t, f.h.UpdateFile, "PUT", `{"folder_id":"`+secret.String()+`"}`, f.unlisted, p); c != 422 {
		t.Fatalf("move into hidden: %d", c)
	}
	if c := f.call(t, f.h.CreateFolder, "POST", `{"name":"n","parent_id":"`+sub.String()+`"}`, f.unlisted, f.teamP()); c != 422 {
		t.Fatalf("create in hidden: %d", c)
	}
	fp := map[string]string{"id": f.team.String(), "folder": sub.String()}
	if c := f.call(t, f.h.UpdateFolder, "PUT", `{"name":"x"}`, f.unlisted, fp); c != 404 {
		t.Fatalf("rename hidden folder: %d", c)
	}
	if c := f.call(t, f.h.DeleteFolder, "DELETE", "", f.unlisted, fp); c != 404 {
		t.Fatalf("delete hidden folder: %d", c)
	}
	if c := f.call(t, f.h.DeleteFile, "DELETE", "", f.unlisted, map[string]string{"id": f.team.String(), "file": f.att.String()}); c != 404 {
		t.Fatalf("delete hidden file: %d", c)
	}
	if c := f.call(t, f.h.PutShares, "PUT", `{"user_ids":["`+f.unlisted.String()+`"]}`, f.member,
		map[string]string{"file": f.att.String()}); c != 200 {
		t.Fatalf("share: %d", c)
	}
	if c := download(f.unlisted); c != 200 {
		t.Fatalf("shared download: %d", c)
	}
	if c := f.call(t, f.h.GetShares, "GET", "", f.unlisted, map[string]string{"file": f.att.String()}); c != 404 {
		t.Fatalf("shares of hidden file: %d", c)
	}
}

func TestDeleteFolder_UnlinksChannel(t *testing.T) {
	f := newChatFixture(t, true)
	if code, _ := f.sendFile(t, f.member, f.general, "a.txt", "x"); code != 201 {
		t.Fatalf("send: %d", code)
	}
	folder := f.linked(t, f.general)
	if c := f.call(t, f.h.DeleteFolder, "DELETE", "", f.owner, map[string]string{"id": f.team.String(), "folder": folder.String()}); c != 204 {
		t.Fatalf("delete folder: %d", c)
	}
	if f.linked(t, f.general) != nil {
		t.Fatal("channel still linked")
	}
	// the next file creates a fresh folder
	if code, _ := f.sendFile(t, f.member, f.general, "b.txt", "y"); code != 201 || f.linked(t, f.general) == nil {
		t.Fatalf("resend: %d", code)
	}
}

func TestDeletedLinkedFile_WireDeleted(t *testing.T) {
	f := newChatFixture(t, true)
	_, m := f.sendFile(t, f.member, f.general, "gone.txt", "x")
	file := m.Attachments[0].ID
	if c := f.call(t, f.h.DeleteFile, "DELETE", "", f.member, map[string]string{"id": f.team.String(), "file": file.String()}); c != 204 {
		t.Fatalf("delete: %d", c)
	}
	rec := serve(t, f.h.ListMessages, "GET", "", f.as(f.guest), map[string]string{"channel": f.general.String()})
	var page struct{ Data []wireMsg }
	if err := jsonDecode(rec, &page); err != nil || len(page.Data) != 1 || len(page.Data[0].Attachments) != 1 {
		t.Fatalf("list: %s", rec.Body)
	}
	if a := page.Data[0].Attachments[0]; a.Kind != "file" || a.ID != file || !a.Deleted || a.Filename != "" {
		t.Fatalf("wire: %+v", a)
	}
}

func TestLinkFolder_Errors(t *testing.T) {
	f := newChatFixture(t, true)
	a := f.folder(t, f.owner, f.team, `{"name":"A"}`)
	if c := f.call(t, f.h.RenameChannel, "PUT", `{"folder_id":""}`, f.owner, f.chanP(uuid.New())); c != 404 {
		t.Fatalf("unknown channel: %d", c)
	}
	if c := f.call(t, f.h.RenameChannel, "PUT", `{"name":" ","folder_id":"`+a.String()+`"}`, f.owner, f.chanP(f.general)); c != 422 || f.linked(t, f.general) != nil {
		t.Fatalf("bad name linked anyway: %d", c)
	}
	if c := f.call(t, f.h.RenameChannel, "PUT", `{}`, f.owner, f.chanP(f.general)); c != 422 {
		t.Fatalf("empty body: %d", c)
	}
	if c := f.call(t, f.h.RenameChannel, "PUT", `{"folder_id":"nope"}`, f.owner, f.chanP(f.general)); c != 422 {
		t.Fatalf("bad id: %d", c)
	}
}

// A private folder inside another private folder needs both channels.
func TestRestrictedFolder_Nested(t *testing.T) {
	f := newPrivFixture(t)
	ctx := context.Background()
	secret := f.linked(t, f.secret)
	sub := f.folder(t, f.member, f.team, `{"name":"sub","parent_id":"`+secret.String()+`"}`)
	inner, err := f.repo.CreateChannel(ctx, f.tenant, f.team, "inner")
	if err != nil {
		t.Fatal(err)
	}
	if err := f.repo.SetAccessList(ctx, f.tenant, f.team, inner.ID, []uuid.UUID{f.unlisted, f.staff}, nil); err != nil {
		t.Fatal(err)
	}
	if c := f.call(t, f.h.RenameChannel, "PUT", `{"folder_id":"`+sub.String()+`"}`, f.owner, f.chanP(inner.ID)); c != 200 {
		t.Fatalf("link: %d", c)
	}
	for _, u := range []struct {
		id   uuid.UUID
		want int
	}{{f.unlisted, 404}, {f.member, 404}, {f.staff, 200}, {f.owner, 200}} {
		req := httptest.NewRequest("GET", "/?folder="+sub.String(), nil)
		if c := serveReq(t, f.h.ListFiles, req, f.as(u.id), f.teamP()).Code; c != u.want {
			t.Fatalf("%s: got %d want %d", u.id, c, u.want)
		}
	}
}
