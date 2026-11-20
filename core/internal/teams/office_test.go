package teams_test

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"core/internal/office"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

func TestOfficeUsesFilePermissions(t *testing.T) {
	f := newChatFixture(t, true)
	_, file := f.upload(t, f.member, "", "Plan.docx", "fixture")
	active := true
	source := f.h.OfficeFiles(func(string) bool { return active })
	resolve := func(c *echo.Context) error {
		doc, ok, err := source.Resolve(c, file)
		if !ok {
			return err
		}
		return c.JSON(200, map[string]any{"editable": doc.Writable, "name": doc.Name})
	}
	for _, tc := range []struct {
		user     uuid.UUID
		status   int
		editable bool
	}{
		{f.owner, 200, true}, {f.member, 200, true}, {f.guest, 200, false}, {f.staff, 404, false}, {f.outside, 404, false},
	} {
		w := serve(t, resolve, "GET", "", f.as(tc.user), nil)
		if w.Code != tc.status {
			t.Fatalf("%s: %d %s", tc.user, w.Code, w.Body)
		}
		if w.Code == 200 {
			var doc map[string]any
			_ = json.Unmarshal(w.Body.Bytes(), &doc)
			if doc["editable"] != tc.editable {
				t.Fatal(doc)
			}
		}
	}
	if code := f.call(t, f.h.PutShares, "PUT", `{"user_ids":["`+f.staff.String()+`"]}`, f.member, map[string]string{"file": file.String()}); code != 200 {
		t.Fatal(code)
	}
	w := serve(t, resolve, "GET", "", f.as(f.staff), nil)
	if w.Code != 200 || !bytes.Contains(w.Body.Bytes(), []byte(`"editable":false`)) {
		t.Fatalf("shared recipient: %d %s", w.Code, w.Body)
	}
	active = false
	if w := serve(t, resolve, "GET", "", f.as(f.owner), nil); w.Code != 404 {
		t.Fatal("inactive module", w.Code)
	}
}

func TestOfficeContentSavePreservesRenameAndOwnership(t *testing.T) {
	f := newChatFixture(t, true)
	_, id := f.upload(t, f.member, "", "Plan.docx", "fixture")
	source := f.h.OfficeFiles(func(string) bool { return true })
	var before office.Document
	w := serve(t, func(c *echo.Context) error {
		var ok bool
		var err error
		before, ok, err = source.Resolve(c, id)
		if !ok {
			return err
		}
		return c.NoContent(200)
	}, "GET", "", f.as(f.member), nil)
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	if code := f.call(t, f.h.UpdateFile, "PUT", `{"name":"Renamed.docx"}`, f.member, map[string]string{"id": f.team.String(), "file": id.String()}); code != 200 {
		t.Fatal(code)
	}
	w = serve(t, func(c *echo.Context) error {
		ok, err := source.Replace(c, before, "updated-key", 123)
		if err != nil {
			return err
		}
		if !ok {
			t.Fatal("save rejected")
		}
		return c.NoContent(200)
	}, "POST", "", f.as(f.member), nil)
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	current, err := f.repo.FindFile(context.Background(), f.tenant, id)
	if err != nil || current.Name != "Renamed.docx" || current.UploadedBy != f.member || current.Size != 123 || current.ObjectKey != "updated-key" {
		t.Fatalf("metadata: %+v %v", current, err)
	}
	w = serve(t, func(c *echo.Context) error {
		ok, err := source.Replace(c, before, "stale-key", 456)
		if ok {
			t.Fatal("stale save accepted")
		}
		return err
	}, "POST", "", f.as(f.member), nil)
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	current, _ = f.repo.FindFile(context.Background(), f.tenant, id)
	if current.ObjectKey != "updated-key" {
		t.Fatal("lost newer save")
	}
}

func TestCreateOfficeDocuments(t *testing.T) {
	f := newChatFixture(t, true)
	for _, kind := range []string{"docx", "xlsx", "pptx"} {
		w := serve(t, f.h.CreateOfficeDocument, "POST", fmt.Sprintf(`{"name":"Planning","kind":%q}`, kind), f.as(f.member), map[string]string{"id": f.team.String()})
		if w.Code != http.StatusCreated {
			t.Fatalf("%s: %d %s", kind, w.Code, w.Body)
		}
		var response struct {
			ID   uuid.UUID `json:"id"`
			Name string    `json:"name"`
		}
		_ = json.Unmarshal(w.Body.Bytes(), &response)
		if response.Name != "Planning."+kind {
			t.Fatal(response.Name)
		}
		file, err := f.repo.FindFile(context.Background(), f.tenant, response.ID)
		if err != nil {
			t.Fatal(err)
		}
		reader, _, err := f.store.Get(context.Background(), file.ObjectKey)
		if err != nil {
			t.Fatal(err)
		}
		var data bytes.Buffer
		_, _ = data.ReadFrom(reader)
		reader.Close()
		if _, err := zip.NewReader(bytes.NewReader(data.Bytes()), int64(data.Len())); err != nil {
			t.Fatal("invalid Office file", err)
		}
	}
	for _, tc := range []struct {
		user   uuid.UUID
		body   string
		status int
	}{
		{f.guest, `{"name":"Plan","kind":"docx"}`, 403}, {f.outside, `{"name":"Plan","kind":"docx"}`, 404},
		{f.member, `{"name":"../Plan","kind":"docx"}`, 422}, {f.member, `{"name":"Plan","kind":"exe"}`, 422},
		{f.member, `{"name":"Plan","kind":"docx","folder_id":"` + uuid.NewString() + `"}`, 422},
	} {
		w := serve(t, f.h.CreateOfficeDocument, "POST", tc.body, f.as(tc.user), map[string]string{"id": f.team.String()})
		if w.Code != tc.status {
			t.Fatalf("%s: %d %s", tc.body, w.Code, w.Body)
		}
	}
}
