package teams_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestNote_SavePreservesFileAndShares(t *testing.T) {
	f := newChatFixture(t, true)
	code, file := f.upload(t, f.member, "", "Notes.OCNOTE", `{"type":"doc","content":[{"type":"paragraph"}]}`)
	if code != 201 {
		t.Fatalf("upload: %d", code)
	}
	params := map[string]string{"id": f.team.String(), "file": file.String()}
	if err := f.repo.SetRecipients(context.Background(), f.tenant, file, []uuid.UUID{f.staff}); err != nil {
		t.Fatal(err)
	}
	download := serve(t, f.h.DownloadFile, "GET", "", f.as(f.member), params)
	version := download.Header().Get("ETag")
	if version == "" {
		t.Fatal("download must supply an ETag")
	}
	content := `{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Bonjour","marks":[{"type":"bold"}]}]}]}`
	body, _ := json.Marshal(map[string]any{"content": json.RawMessage(content), "version": version})
	res := serve(t, f.h.UpdateNote, "PUT", string(body), f.as(f.member), params)
	if res.Code != 200 {
		t.Fatalf("save: %d %s", res.Code, res.Body)
	}
	// Shared recipients read the updated bytes using the same file id.
	after := serve(t, f.h.DownloadFile, "GET", "", f.as(f.staff), params)
	if after.Code != 200 || after.Body.String() != content || after.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("download after save: %d %s", after.Code, after.Body)
	}
	if after.Header().Get("ETag") == version || len(f.store.objs) != 1 {
		t.Fatal("save must change the version and clean up the old object")
	}
	stored, err := f.repo.FindFile(context.Background(), f.tenant, file)
	if err != nil || stored.UploadedBy != f.member || stored.Name != "Notes.OCNOTE" || stored.Size != int64(len(content)) {
		t.Fatalf("file metadata: %+v %v", stored, err)
	}
	// An already-open editor must not overwrite this save.
	res = serve(t, f.h.UpdateNote, "PUT", string(body), f.as(f.owner), params)
	if res.Code != 409 || len(f.store.objs) != 1 {
		t.Fatalf("stale save: %d %s", res.Code, res.Body)
	}
}

func TestNote_ValidationAndPermissions(t *testing.T) {
	f := newChatFixture(t, true)
	_, file := f.upload(t, f.member, "", "note.ocnote", "")
	p := map[string]string{"id": f.team.String(), "file": file.String()}
	for _, tc := range []struct {
		name string
		user uuid.UUID
		body string
		code int
	}{
		{"guest", f.guest, `{}`, 403},
		{"another member", f.guest2(t), `{}`, 403},
		{"non-member", f.outside, `{}`, 404},
		{"malformed", f.member, `{`, 422},
		{"not a document", f.member, `{"content":{"type":"paragraph"},"version":"x"}`, 422},
		{"missing version", f.member, `{"content":{"type":"doc","content":[]}}`, 422},
		{"too large", f.member, strings.Repeat("x", (10<<20)+1), 413},
	} {
		t.Run(tc.name, func(t *testing.T) {
			res := serve(t, f.h.UpdateNote, "PUT", tc.body, f.as(tc.user), p)
			if res.Code != tc.code {
				t.Fatalf("got %d: %s, want %d", res.Code, res.Body, tc.code)
			}
		})
	}
	_, text := f.upload(t, f.member, "", "plain.txt", "original")
	p["file"] = text.String()
	if code := f.call(t, f.h.UpdateNote, "PUT", `{}`, f.member, p); code != 422 {
		t.Fatalf("non-note update: %d", code)
	}
}

func TestNote_ConcurrentContentReplacement(t *testing.T) {
	f := newChatFixture(t, true)
	_, file := f.upload(t, f.member, "", "note.ocnote", "")
	ctx := context.Background()
	original, err := f.repo.FindFile(ctx, f.tenant, file)
	if err != nil {
		t.Fatal(err)
	}
	changed := original
	changed.ObjectKey = "new-version"
	if ok, err := f.repo.ReplaceFileContent(ctx, changed, original.ObjectKey); err != nil || !ok {
		t.Fatalf("replace: %v, %v", ok, err)
	}
	if ok, err := f.repo.ReplaceFileContent(ctx, original, original.ObjectKey); err != nil || ok {
		t.Fatalf("stale replace: %v, %v", ok, err)
	}
	// A rename based on the previous metadata must keep the new object key.
	original.Name = "renamed.ocnote"
	renamed, err := f.repo.UpdateFile(ctx, original)
	if err != nil || renamed.ObjectKey != changed.ObjectKey {
		t.Fatalf("rename reverted content: %+v, %v", renamed, err)
	}
	changed.TenantID = uuid.New()
	if ok, err := f.repo.ReplaceFileContent(ctx, changed, changed.ObjectKey); err != nil || ok {
		t.Fatalf("cross-tenant replace: %v, %v", ok, err)
	}
}
