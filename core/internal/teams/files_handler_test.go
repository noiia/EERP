package teams_test

import (
	"bytes"
	"context"
	"mime/multipart"
	"net/http/httptest"
	"testing"

	"core/internal/teams"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

func (f chatFixture) upload(t *testing.T, as uuid.UUID, folder, name, content string) (int, uuid.UUID) {
	t.Helper()
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	if folder != "" {
		_ = w.WriteField("folder_id", folder)
	}
	fw, err := w.CreateFormFile("file", name)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = fw.Write([]byte(content))
	_ = w.Close()
	req := httptest.NewRequest("POST", "/", &buf)
	req.Header.Set("Content-Type", w.FormDataContentType())
	rec := serveReq(t, f.h.UploadFile, req, f.as(as), map[string]string{"id": f.team.String()})
	var out struct{ ID uuid.UUID }
	_ = jsonDecode(rec, &out)
	return rec.Code, out.ID
}

func (f chatFixture) folder(t *testing.T, as uuid.UUID, team uuid.UUID, body string) uuid.UUID {
	t.Helper()
	rec := serve(t, f.h.CreateFolder, "POST", body, f.as(as), map[string]string{"id": team.String()})
	if rec.Code != 201 {
		t.Fatalf("create folder: %d %s", rec.Code, rec.Body)
	}
	var out struct{ ID uuid.UUID }
	_ = jsonDecode(rec, &out)
	return out.ID
}

func (f chatFixture) call(t *testing.T, fn echo.HandlerFunc, method, body string, as uuid.UUID, params map[string]string) int {
	t.Helper()
	return serve(t, fn, method, body, f.as(as), params).Code
}

func TestFiles_RoleMatrix(t *testing.T) {
	f := newChatFixture(t, true)
	if code, _ := f.upload(t, f.guest, "", "g.txt", "x"); code != 403 {
		t.Fatalf("guest upload: %d", code)
	}
	if c := f.call(t, f.h.CreateFolder, "POST", `{"name":"g"}`, f.guest, map[string]string{"id": f.team.String()}); c != 403 {
		t.Fatalf("guest folder: %d", c)
	}
	code, file := f.upload(t, f.member, "", "m.txt", "hello")
	if code != 201 {
		t.Fatalf("member upload: %d", code)
	}
	member2 := f.guest2(t)
	p := map[string]string{"id": f.team.String(), "file": file.String()}
	if c := f.call(t, f.h.DeleteFile, "DELETE", "", member2, p); c != 403 {
		t.Fatalf("other member delete: %d", c)
	}
	if c := f.call(t, f.h.UpdateFile, "PUT", `{"name":"x.txt"}`, member2, p); c != 403 {
		t.Fatalf("other member rename: %d", c)
	}
	if c := f.call(t, f.h.UpdateFile, "PUT", `{"name":"mine.txt"}`, f.member, p); c != 200 {
		t.Fatalf("own rename: %d", c)
	}
	if c := f.call(t, f.h.DeleteFile, "DELETE", "", f.owner, p); c != 204 {
		t.Fatalf("owner delete: %d", c)
	}
	if len(f.store.objs) != 0 {
		t.Fatalf("object left after delete: %d", len(f.store.objs))
	}
	if c := f.call(t, f.h.ListFiles, "GET", "", f.outside, map[string]string{"id": f.team.String()}); c != 404 {
		t.Fatalf("non-member list: %d", c)
	}
}

func TestFiles_ListingWithPath(t *testing.T) {
	f := newChatFixture(t, true)
	a := f.folder(t, f.member, f.team, `{"name":"A"}`)
	b := f.folder(t, f.member, f.team, `{"name":"B","parent_id":"`+a.String()+`"}`)
	if code, _ := f.upload(t, f.member, b.String(), "in-b.txt", "hey"); code != 201 {
		t.Fatalf("upload: %d", code)
	}
	req := httptest.NewRequest("GET", "/?folder="+b.String(), nil)
	rec := serveReq(t, f.h.ListFiles, req, f.as(f.guest), map[string]string{"id": f.team.String()})
	var out struct {
		Folder *struct{ ID uuid.UUID }
		Path   []struct{ Name string }
		Files  []struct {
			Name           string
			UploadedByName string `json:"uploaded_by_name"`
			SharedWith     int    `json:"shared_with"`
		}
	}
	if err := jsonDecode(rec, &out); err != nil || rec.Code != 200 || out.Folder == nil || out.Folder.ID != b ||
		len(out.Path) != 2 || out.Path[0].Name != "A" || out.Path[1].Name != "B" || len(out.Files) != 1 || out.Files[0].Name != "in-b.txt" {
		t.Fatalf("listing: %d %s", rec.Code, rec.Body)
	}
	rec = serve(t, f.h.ListFiles, "GET", "", f.as(f.guest), map[string]string{"id": f.team.String()})
	var root struct {
		Folder  *struct{}
		Folders []struct{ Name string }
		Files   []struct{}
	}
	if err := jsonDecode(rec, &root); err != nil || root.Folder != nil || len(root.Folders) != 1 || len(root.Files) != 0 {
		t.Fatalf("root: %s", rec.Body)
	}
}

func TestMoveFolderIntoDescendant_422(t *testing.T) {
	f := newChatFixture(t, true)
	a := f.folder(t, f.member, f.team, `{"name":"A"}`)
	b := f.folder(t, f.member, f.team, `{"name":"B","parent_id":"`+a.String()+`"}`)
	c := f.folder(t, f.member, f.team, `{"name":"C","parent_id":"`+b.String()+`"}`)
	p := map[string]string{"id": f.team.String(), "folder": a.String()}
	for _, target := range []uuid.UUID{a, c} {
		if code := f.call(t, f.h.UpdateFolder, "PUT", `{"parent_id":"`+target.String()+`"}`, f.member, p); code != 422 {
			t.Fatalf("move into %s: %d", target, code)
		}
	}
	// moving C to the root is fine
	if code := f.call(t, f.h.UpdateFolder, "PUT", `{"parent_id":""}`, f.member, map[string]string{"id": f.team.String(), "folder": c.String()}); code != 200 {
		t.Fatalf("move to root: %d", code)
	}
}

func TestDeleteFolderTree_RemovesObjects(t *testing.T) {
	f := newChatFixture(t, true)
	a := f.folder(t, f.member, f.team, `{"name":"A"}`)
	b := f.folder(t, f.member, f.team, `{"name":"B","parent_id":"`+a.String()+`"}`)
	for _, dir := range []uuid.UUID{a, b} {
		if code, _ := f.upload(t, f.member, dir.String(), "f.txt", "x"); code != 201 {
			t.Fatalf("upload: %d", code)
		}
	}
	if code, _ := f.upload(t, f.member, "", "keep.txt", "k"); code != 201 {
		t.Fatalf("upload root: %d", code)
	}
	if len(f.store.objs) != 3 {
		t.Fatalf("stored %d", len(f.store.objs))
	}
	if code := f.call(t, f.h.DeleteFolder, "DELETE", "", f.member, map[string]string{"id": f.team.String(), "folder": a.String()}); code != 204 {
		t.Fatalf("delete folder: %d", code)
	}
	if len(f.store.objs) != 1 {
		t.Fatalf("objects left: %d, want only the root file", len(f.store.objs))
	}
	var n int
	if err := f.app.DB.QueryRow(context.Background(), `SELECT (SELECT count(*) FROM team_folder WHERE team_id=$1)
		+ (SELECT count(*) FROM team_file WHERE team_id=$1)`, f.team).Scan(&n); err != nil || n != 1 {
		t.Fatalf("rows left = %d, %v", n, err)
	}
}

func TestShare_RecipientCanDownload_OthersCannot(t *testing.T) {
	f := newChatFixture(t, true)
	_, file := f.upload(t, f.member, "", "doc.txt", "secret")
	sp := map[string]string{"file": file.String()}
	if c := f.call(t, f.h.PutShares, "PUT", `{"user_ids":["`+f.staff.String()+`"]}`, f.guest, sp); c != 403 {
		t.Fatalf("guest share: %d", c)
	}
	if c := f.call(t, f.h.PutShares, "PUT", `{"user_ids":["`+f.website.String()+`"]}`, f.member, sp); c != 422 {
		t.Fatalf("website recipient: %d", c)
	}
	if c := f.call(t, f.h.PutShares, "PUT", `{"user_ids":["`+f.staff.String()+`"]}`, f.member, sp); c != 200 {
		t.Fatalf("share: %d", c)
	}
	rec := serve(t, f.h.DownloadFile, "GET", "", f.as(f.staff), sp)
	if rec.Code != 200 || rec.Body.String() != "secret" || rec.Header().Get("Content-Disposition") == "" {
		t.Fatalf("recipient download: %d %s", rec.Code, rec.Body)
	}
	if c := f.call(t, f.h.DownloadFile, "GET", "", f.outside, sp); c != 404 {
		t.Fatalf("outsider download: %d", c)
	}
	if c := f.call(t, f.h.DownloadFile, "GET", "", f.guest, sp); c != 200 {
		t.Fatalf("team guest download: %d", c)
	}
	rec = serve(t, f.h.GetShares, "GET", "", f.as(f.guest), sp)
	var shares struct {
		Data []struct {
			UserID uuid.UUID `json:"user_id"`
		}
	}
	if err := jsonDecode(rec, &shares); err != nil || len(shares.Data) != 1 || shares.Data[0].UserID != f.staff {
		t.Fatalf("shares: %s", rec.Body)
	}
	// a recipient sees the file only, not the share list
	if c := f.call(t, f.h.GetShares, "GET", "", f.staff, sp); c != 404 {
		t.Fatalf("recipient shares list: %d", c)
	}
	// replacing the list revokes
	if c := f.call(t, f.h.PutShares, "PUT", `{"user_ids":[]}`, f.member, sp); c != 200 {
		t.Fatalf("unshare: %d", c)
	}
	if c := f.call(t, f.h.DownloadFile, "GET", "", f.staff, sp); c != 404 {
		t.Fatalf("revoked download: %d", c)
	}
}

func TestShared_ListsOnlyMine(t *testing.T) {
	f := newChatFixture(t, true)
	_, mine := f.upload(t, f.member, "", "mine.txt", "a")
	_, theirs := f.upload(t, f.member, "", "theirs.txt", "b")
	if c := f.call(t, f.h.PutShares, "PUT", `{"user_ids":["`+f.staff.String()+`"]}`, f.member, map[string]string{"file": mine.String()}); c != 200 {
		t.Fatalf("share mine: %d", c)
	}
	if c := f.call(t, f.h.PutShares, "PUT", `{"user_ids":["`+f.outside.String()+`"]}`, f.member, map[string]string{"file": theirs.String()}); c != 200 {
		t.Fatalf("share theirs: %d", c)
	}
	rec := serve(t, f.h.ListShared, "GET", "", f.as(f.staff), nil)
	var out struct {
		Data []struct {
			ID       uuid.UUID
			TeamName string `json:"team_name"`
		}
	}
	if err := jsonDecode(rec, &out); err != nil || len(out.Data) != 1 || out.Data[0].ID != mine || out.Data[0].TeamName != "T" {
		t.Fatalf("shared: %s", rec.Body)
	}
}

func TestFolderOtherTeam_422(t *testing.T) {
	f := newChatFixture(t, true)
	other, _, err := f.repo.CreateTeam(context.Background(), teams.Team{TenantID: f.tenant, Name: "Other"}, f.member)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = f.repo.DeleteTeam(context.Background(), f.tenant, other.ID) })
	foreign := f.folder(t, f.member, other.ID, `{"name":"X"}`)
	if code, _ := f.upload(t, f.member, foreign.String(), "a.txt", "a"); code != 422 {
		t.Fatalf("upload into other team's folder: %d", code)
	}
	if c := f.call(t, f.h.CreateFolder, "POST", `{"name":"Y","parent_id":"`+foreign.String()+`"}`, f.member, map[string]string{"id": f.team.String()}); c != 422 {
		t.Fatalf("folder under other team's folder: %d", c)
	}
	mine := f.folder(t, f.member, f.team, `{"name":"M"}`)
	if c := f.call(t, f.h.UpdateFolder, "PUT", `{"parent_id":"`+foreign.String()+`"}`, f.member, map[string]string{"id": f.team.String(), "folder": mine.String()}); c != 422 {
		t.Fatalf("move to other team's folder: %d", c)
	}
	_, file := f.upload(t, f.member, "", "b.txt", "b")
	if c := f.call(t, f.h.UpdateFile, "PUT", `{"folder_id":"`+foreign.String()+`"}`, f.member, map[string]string{"id": f.team.String(), "file": file.String()}); c != 422 {
		t.Fatalf("move file to other team's folder: %d", c)
	}
}
