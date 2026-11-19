package teams_test

import (
	"archive/zip"
	"bytes"
	"io"
	"net/http/httptest"
	"sort"
	"sync"
	"testing"

	"github.com/google/uuid"
)

func TestFolders_NamesUniquePerFolder(t *testing.T) {
	f := newChatFixture(t, true)
	team := map[string]string{"id": f.team.String()}
	docs := f.folder(t, f.member, f.team, `{"name":"Docs"}`)
	rec := serve(t, f.h.CreateFolder, "POST", `{"name":" docs "}`, f.as(f.member), team)
	if rec.Code != 409 || !bytes.Contains(rec.Body.Bytes(), []byte("NAME_TAKEN")) {
		t.Fatalf("same name, other case: %d %s", rec.Code, rec.Body)
	}
	// The same name in another folder is fine.
	f.folder(t, f.member, f.team, `{"name":"Docs","parent_id":"`+docs.String()+`"}`)
	other := f.folder(t, f.member, f.team, `{"name":"Other"}`)
	p := map[string]string{"id": f.team.String(), "folder": other.String()}
	if c := f.call(t, f.h.UpdateFolder, "PUT", `{"name":"DOCS"}`, f.member, p); c != 409 {
		t.Fatalf("rename onto a sibling: %d", c)
	}
	if c := f.call(t, f.h.UpdateFolder, "PUT", `{"name":"other"}`, f.member, p); c != 200 {
		t.Fatalf("rename to itself, other case: %d", c)
	}
}

// A double-clicked "New folder" sends the same request twice at once: one folder.
func TestFolders_ConcurrentCreatesMakeOne(t *testing.T) {
	f := newChatFixture(t, true)
	codes := make([]int, 6)
	var wg sync.WaitGroup
	for i := range codes {
		wg.Add(1)
		go func() {
			defer wg.Done()
			codes[i] = serve(t, f.h.CreateFolder, "POST", `{"name":"Twice"}`, f.as(f.member), map[string]string{"id": f.team.String()}).Code
		}()
	}
	wg.Wait()
	sort.Ints(codes)
	if codes[0] != 201 || codes[1] != 409 || codes[len(codes)-1] != 409 {
		t.Fatalf("codes: %v", codes)
	}
}

func TestFiles_SameNameGetsSuffixOnUpload_RefusedOnRename(t *testing.T) {
	f := newChatFixture(t, true)
	name := func(id uuid.UUID) string {
		var n string
		if err := f.app.DB.QueryRow(t.Context(), `SELECT name FROM team_file WHERE id=$1`, id).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	_, a := f.upload(t, f.member, "", "report.pdf", "1")
	_, b := f.upload(t, f.member, "", "Report.pdf", "2")
	_, c := f.upload(t, f.member, "", "report.pdf", "3")
	if name(a) != "report.pdf" || name(b) != "Report (2).pdf" || name(c) != "report (3).pdf" {
		t.Fatalf("names: %q %q %q", name(a), name(b), name(c))
	}
	p := map[string]string{"id": f.team.String(), "file": c.String()}
	if code := f.call(t, f.h.UpdateFile, "PUT", `{"name":"REPORT.pdf"}`, f.member, p); code != 409 {
		t.Fatalf("rename onto a sibling: %d", code)
	}
	// Moving into a folder holding that name is refused too.
	dir := f.folder(t, f.member, f.team, `{"name":"In"}`)
	if code, _ := f.upload(t, f.member, dir.String(), "report.pdf", "4"); code != 201 {
		t.Fatalf("upload in folder: %d", code)
	}
	p["file"] = a.String()
	if code := f.call(t, f.h.UpdateFile, "PUT", `{"folder_id":"`+dir.String()+`"}`, f.member, p); code != 409 {
		t.Fatalf("move onto a same-named file: %d", code)
	}
}

func TestDownloadFolder_ZipsTheSubtree(t *testing.T) {
	f := newChatFixture(t, true)
	a := f.folder(t, f.member, f.team, `{"name":"A"}`)
	b := f.folder(t, f.member, f.team, `{"name":"../B","parent_id":"`+a.String()+`"}`)
	f.upload(t, f.member, a.String(), "x.txt", "ex")
	f.upload(t, f.member, b.String(), "y.txt", "why")
	f.upload(t, f.member, "", "outside.txt", "no")
	req := httptest.NewRequest("GET", "/", nil)
	rec := serveReq(t, f.h.DownloadFolder, req, f.as(f.guest), map[string]string{"id": f.team.String(), "folder": a.String()})
	if rec.Code != 200 || rec.Header().Get("Content-Type") != "application/zip" {
		t.Fatalf("download: %d %s", rec.Code, rec.Header())
	}
	zr, err := zip.NewReader(bytes.NewReader(rec.Body.Bytes()), int64(rec.Body.Len()))
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, e := range zr.File {
		r, _ := e.Open()
		body, _ := io.ReadAll(r)
		got[e.Name] = string(body)
	}
	want := map[string]string{"A/": "", "A/.._B/": "", "A/x.txt": "ex", "A/.._B/y.txt": "why"}
	if len(got) != len(want) {
		t.Fatalf("entries: %v", got)
	}
	for k, v := range want {
		if got[k] != v {
			t.Fatalf("entry %q: %q (all: %v)", k, got[k], got)
		}
	}
	if c := f.call(t, f.h.DownloadFolder, "GET", "", f.outside, map[string]string{"id": f.team.String(), "folder": a.String()}); c != 404 {
		t.Fatalf("non-member: %d", c)
	}
}
