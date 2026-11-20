package project

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"core/internal/auth"
	"core/orm/access"
	ormserver "core/orm/server"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

// The routes: the three calls the wizard makes, seen as HTTP. What the handlers
// owe the browser is not the comparison (Tasks 5 and 7 cover that) but the
// answer around it: who gets through, what a refused file looks like, and the
// base the apply has to be handed back.

// ── The mounted routes ───────────────────────────────────────────────────────

// exMount puts the exchange routes on an echo of their own, the way app.go does
// it, and returns it. Their own, because the cap under test has to be the right
// one: the fixture's echo is built with an empty ormserver.Config, so it caps
// every body at the server-wide 1M JSON default with nothing exempted, and a
// five-thousand-task plan would be refused before the handler ever saw it. app.go
// exempts /api/v1/project/<id>/exchange from that cap and hands these routes
// uploadLimit; the test mirrors the posture with the same cap the real server
// uses (UploadBodyLimitOrDefault's "20M"), so what a giant file answers here is
// the handler's own ceiling and not somebody else's.
//
// Only these three routes live here: the exchange handlers read and write through
// the database directly, so they need none of the generic CRUD surface the
// fixture's echo carries.
func exMount(t *testing.T, f *fixture) *echo.Echo {
	t.Helper()
	e := echo.New()
	NewHandler(f.app.DB, auth.NewPermissionRepository(f.app.DB)).MountExchange(e, ormserver.BodyLimit("20M"))
	return e
}

// exGet serves path as who and hands back the status, the headers and the raw
// body: an export is a file, not a JSON envelope.
func exGet(t *testing.T, e *echo.Echo, who auth.Identity, path string) (int, http.Header, []byte) {
	t.Helper()
	req := exRequest(t, who, http.MethodGet, "/api/v1/"+path, nil, "")
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	return rec.Code, rec.Header(), rec.Body.Bytes()
}

// exPostFile posts a multipart form: the file part, and (for the apply) the base
// and the ticked keys the wizard sends back. This is the multipart twin of
// validate_test.go's f.do.
func exPostFile(t *testing.T, e *echo.Echo, who auth.Identity, path, filename string, file []byte,
	base string, keys []string) (int, map[string]any) {
	t.Helper()
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	if file != nil {
		part, err := w.CreateFormFile("file", filename)
		if err != nil {
			t.Fatalf("form file: %v", err)
		}
		if _, err := part.Write(file); err != nil {
			t.Fatalf("form file body: %v", err)
		}
	}
	if base != "" {
		if err := w.WriteField("base", base); err != nil {
			t.Fatalf("form field: %v", err)
		}
	}
	for _, k := range keys {
		if err := w.WriteField("keys", k); err != nil {
			t.Fatalf("form field: %v", err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatalf("close form: %v", err)
	}
	req := exRequest(t, who, http.MethodPost, "/api/v1/"+path, &body, w.FormDataContentType())
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

// exRequest stamps the context the way the JWT middleware does, which is all of
// the real server's stack a handler test needs.
func exRequest(t *testing.T, who auth.Identity, method, path string, body *bytes.Buffer, contentType string) *http.Request {
	t.Helper()
	ctx := auth.SetIdentity(context.Background(), who)
	ctx = access.WithTenant(ctx, who.TenantID)
	ctx = access.WithGroups(ctx, who.Groups)
	var r *bytes.Reader
	if body != nil {
		r = bytes.NewReader(body.Bytes())
	} else {
		r = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, path, r).WithContext(ctx)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	return req
}

// ── The answers ──────────────────────────────────────────────────────────────

// exPreviewAnswer is what POST …/preview answers: the rows, the file's warnings,
// and the base the apply has to come back with.
type exPreviewAnswer struct {
	Base     string    `json:"base"`
	Changes  []Change  `json:"changes"`
	Warnings []Warning `json:"warnings"`
}

// exRoutePreview posts file as the preview of pid and fails the test on anything
// but a 200.
func exRoutePreview(t *testing.T, e *echo.Echo, who auth.Identity, pid uuid.UUID, filename string,
	file []byte) exPreviewAnswer {
	t.Helper()
	code, body := exPostFile(t, e, who, "project/"+pid.String()+"/exchange/gan/preview", filename, file, "", nil)
	if code != http.StatusOK {
		t.Fatalf("preview %s: %d %v, want 200", filename, code, body)
	}
	var got exPreviewAnswer
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("re-encode preview: %v", err)
	}
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("preview body %s: %v", raw, err)
	}
	return got
}

// exApplyRoute posts the same file with the base and the ticked keys.
func exApplyRoute(t *testing.T, e *echo.Echo, who auth.Identity, pid uuid.UUID, filename string,
	file []byte, base string, keys []string) (int, map[string]any) {
	t.Helper()
	return exPostFile(t, e, who, "project/"+pid.String()+"/exchange/gan/apply", filename, file, base, keys)
}

// exErr is the answer's error code, which is what the wizard switches on.
func exErr(t *testing.T, body map[string]any) string {
	t.Helper()
	e, _ := body["error"].(map[string]any)
	if e == nil {
		t.Fatalf("answer %v holds no error object", body)
	}
	code, _ := e["code"].(string)
	return code
}

// exErrFields is an error answer's code and the change keys it names, which is how
// the wizard knows which rows to highlight.
func exErrFields(t *testing.T, body map[string]any) (string, []string) {
	t.Helper()
	e, _ := body["error"].(map[string]any)
	if e == nil {
		t.Fatalf("answer %v holds no error object", body)
	}
	code, _ := e["code"].(string)
	return code, asStrings(e["fields"])
}

func asStrings(v any) []string {
	raw, _ := v.([]any)
	var out []string
	for _, item := range raw {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// exGanFile is a fixture's bytes, which is what an upload carries.
func exGanFile(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "gan", name))
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	return raw
}

// ── Export ───────────────────────────────────────────────────────────────────

// TestExchange_Export: the download a manager clicks. It has to arrive as a file
// they can recognise (the project's own name) and as a plan EERP would accept
// back, and it is a read: anyone who can see the project gets it, and nobody
// else learns that it exists.
func TestExchange_Export(t *testing.T) {
	e := exFixture(t)
	f, pid := e.f, e.pid
	x := exMount(t, f)
	f.exec(`UPDATE project SET name = 'House build' WHERE id = $1`, pid)

	t.Run("the manager gets the file", func(t *testing.T) {
		code, head, body := exGet(t, x, f.caller(e.mgr), "project/"+pid.String()+"/exchange/gan/export")
		if code != http.StatusOK {
			t.Fatalf("export: %d %s, want 200", code, body)
		}
		if got := head.Get("Content-Type"); got != "application/xml" {
			t.Errorf("Content-Type = %q, want application/xml", got)
		}
		if got, want := head.Get("Content-Disposition"), `attachment; filename="House build.gan"`; got != want {
			t.Errorf("Content-Disposition = %q, want %q", got, want)
		}
		// The body is a plan, and the project's own: reading it back is how the
		// test says the bytes are the file rather than a page about it.
		got, warnings, err := ganFormat{}.Decode(bytes.NewReader(body))
		if err != nil {
			t.Fatalf("the exported file does not decode: %v\n%s", err, body)
		}
		if len(warnings) != 0 {
			t.Errorf("the exported file decodes with warnings %+v", warnings)
		}
		want, _ := ganDecodeFile(t, "basic.gan")
		if len(got.Tasks) != len(want.Tasks) {
			t.Fatalf("the export holds %d rows, want the project's %d", len(got.Tasks), len(want.Tasks))
		}
		for i := range want.Tasks {
			if got.Tasks[i].Name != want.Tasks[i].Name {
				t.Errorf("row %d is %q, want %q", i, got.Tasks[i].Name, want.Tasks[i].Name)
			}
		}
	})

	t.Run("everyone sees a visible project's file", func(t *testing.T) {
		code, _, _ := exGet(t, x, f.caller(e.ann), "project/"+pid.String()+"/exchange/gan/export")
		if code != http.StatusOK {
			t.Errorf("export as a plain member: %d, want 200", code)
		}
	})

	t.Run("an invisible project is no such thing", func(t *testing.T) {
		hidden := f.project(e.mgr, "members")
		if code, _, _ := exGet(t, x, f.caller(e.ann), "project/"+hidden.String()+"/exchange/gan/export"); code != http.StatusNotFound {
			t.Errorf("export of a members-only project as an outsider: %d, want 404", code)
		}
		if code, _, _ := exGet(t, x, f.caller(e.mgr), "project/"+uuid.New().String()+"/exchange/gan/export"); code != http.StatusNotFound {
			t.Errorf("export of a project that is not there: %d, want 404", code)
		}
	})

	t.Run("a format EERP does not speak is 404", func(t *testing.T) {
		// 404, not 422: nothing was read, so there is nothing about the file to
		// refuse. The wizard cannot invent a format, and a probe learns no more
		// than that the route is not there.
		code, _, _ := exGet(t, x, f.caller(e.mgr), "project/"+pid.String()+"/exchange/xyz/export")
		if code != http.StatusNotFound {
			t.Errorf("export as .xyz: %d, want 404", code)
		}
	})

	t.Run("a name the filesystem would refuse is made safe", func(t *testing.T) {
		f.exec(`UPDATE project SET name = 'R&D / "Q1" <plan>!' WHERE id = $1`, pid)
		_, head, _ := exGet(t, x, f.caller(e.mgr), "project/"+pid.String()+"/exchange/gan/export")
		if got := head.Get("Content-Disposition"); !strings.Contains(got, `filename="RD Q1 plan.gan"`) {
			t.Errorf("Content-Disposition = %q, want the name kept to letters, digits, space, dot and dash", got)
		}

		f.exec(`UPDATE project SET name = '///' WHERE id = $1`, pid)
		_, head, _ = exGet(t, x, f.caller(e.mgr), "project/"+pid.String()+"/exchange/gan/export")
		if got := head.Get("Content-Disposition"); !strings.Contains(got, `filename="project.gan"`) {
			t.Errorf("Content-Disposition = %q, want the fallback name project.gan", got)
		}

		// The alphabet kept is letters and digits of ANY script, not [\w .-]'s ASCII
		// only: EERP's project names are French, and a download called
		// "Cration du pont.gan" (what an ASCII filter leaves) is no way to find a file
		// again. What has to go is what a header or a filesystem cannot carry, and an
		// accented vowel is neither.
		f.exec(`UPDATE project SET name = 'Création du pont “A”' WHERE id = $1`, pid)
		_, head, _ = exGet(t, x, f.caller(e.mgr), "project/"+pid.String()+"/exchange/gan/export")
		if got := head.Get("Content-Disposition"); !strings.Contains(got, `filename="Création du pont A.gan"`) {
			t.Errorf("Content-Disposition = %q, want the accented name kept and the quotes dropped", got)
		}
	})
}

// ── Who gets to import ───────────────────────────────────────────────────────

// TestExchange_PreviewPermissions: an import writes, so it belongs to the people
// who run the project. Seeing the plan is not a licence to change it, and an
// outsider is not told the project exists.
func TestExchange_PreviewPermissions(t *testing.T) {
	e := exFixture(t)
	f, pid := e.f, e.pid
	x := exMount(t, f)
	file := exGanFile(t, "partner_edited.gan")
	hidden := f.project(e.mgr, "members")

	t.Run("the manager previews", func(t *testing.T) {
		got := exRoutePreview(t, x, f.caller(e.mgr), pid, "partner_edited.gan", file)
		if got.Base == "" {
			t.Error("the preview came back without a base, so no apply could be sent")
		}
		if len(got.Changes) == 0 {
			t.Error("the preview came back with no rows")
		}
	})

	t.Run("a project admin previews", func(t *testing.T) {
		got := exRoutePreview(t, x, f.caller(uuid.New(), AdminGroup), pid, "partner_edited.gan", file)
		if len(got.Changes) == 0 {
			t.Error("the admin's preview came back with no rows")
		}
	})

	t.Run("a viewer is refused", func(t *testing.T) {
		// Ann sees the project (it is an everyone project) and is not its manager:
		// the answer is 403, because hiding it would tell her nothing about a
		// project she is allowed to read.
		code, body := exPostFile(t, x, f.caller(e.ann),
			"project/"+pid.String()+"/exchange/gan/preview", "partner_edited.gan", file, "", nil)
		if code != http.StatusForbidden {
			t.Errorf("preview as a member who is not the manager: %d %v, want 403", code, body)
		}
		if code, body := exPostFile(t, x, f.caller(e.ann),
			"project/"+pid.String()+"/exchange/gan/apply", "partner_edited.gan", file, "", nil); code != http.StatusForbidden {
			t.Errorf("apply as a member who is not the manager: %d %v, want 403", code, body)
		}
	})

	t.Run("an outsider is not told it exists", func(t *testing.T) {
		for _, action := range []string{"preview", "apply"} {
			code, body := exPostFile(t, x, f.caller(uuid.New()),
				"project/"+hidden.String()+"/exchange/gan/"+action, "partner_edited.gan", file, "", nil)
			if code != http.StatusNotFound {
				t.Errorf("%s of a members-only project as a stranger: %d %v, want 404", action, code, body)
			}
		}
	})
}

// ── The round trip ───────────────────────────────────────────────────────────

// TestExchange_PreviewAndApply is the wizard's whole conversation over HTTP: the
// file goes up, the reviewed rows and their base come back, the ticks go up with
// the base, and the project is what the manager agreed to.
func TestExchange_PreviewAndApply(t *testing.T) {
	e := exFixture(t)
	f, pid := e.f, e.pid
	x := exMount(t, f)
	file := exGanFile(t, "partner_edited.gan")
	name := "partner_edited.gan"

	got := exRoutePreview(t, x, f.caller(e.mgr), pid, name, file)
	if len(got.Changes) != 5 {
		t.Fatalf("the preview holds %d rows, want the file's five: %s", len(got.Changes), strings.Join(exKeysOf(got.Changes), " "))
	}
	if len(got.Warnings) != 0 {
		t.Errorf("the preview warns %+v, want nothing about a well formed file", got.Warnings)
	}
	keys := exDefaultKeys(got.Changes)
	if len(keys) != 3 {
		t.Fatalf("the preview ticks %s, want the three the wizard shows selected", strings.Join(keys, " "))
	}

	code, body := exApplyRoute(t, x, f.caller(e.mgr), pid, name, file, got.Base, keys)
	if code != http.StatusOK {
		t.Fatalf("apply: %d %v, want 200", code, body)
	}
	if n, _ := body["applied"].(float64); int(n) != len(keys) {
		t.Errorf("applied %v, want %d", body["applied"], len(keys))
	}

	// The row the manager ticked is in the database, not only in the answer.
	framing := uuid.MustParse(ganFramingRef)
	if got := exColumn[*time.Time](t, f, "project_task", framing, "deadline"); got == nil ||
		!got.Equal(exchangeDay(2026, time.January, 26)) {
		t.Errorf("Framing's deadline is %v, want the file's 2026-01-26", got)
	}

	// And the same conversation a second time asks for nothing that was agreed to.
	// What is left is the two removals nobody ticked, still offered and still
	// unticked, plus the rows about the task the file invented: it carries no
	// eerp_id, so the uuid EERP gave it on import names nothing in the file and it
	// is offered again as a create beside its own removal. Matching is by eerp_id
	// only (never by name), so that residue is the design, not a bug; TestApply_ThenPreviewIsEmpty
	// pins the same six rows one level down.
	again := exRoutePreview(t, x, f.caller(e.mgr), pid, name, file)
	created := exRowByName(t, f, "project_task", "Safety inspection")
	want := append(exUntickedKeys(got.Changes),
		"new:7",
		exDepKey(ganFramingRef, "new:7", false),
		changeKey(created.String(), "delete"),
		exDepKey(ganFramingRef, created.String(), true),
	)
	left, wantSorted := slices.Clone(exKeysOf(again.Changes)), slices.Clone(want)
	slices.Sort(left)
	slices.Sort(wantSorted)
	if !slices.Equal(left, wantSorted) {
		t.Errorf("after the import the preview holds %s, want %s", strings.Join(left, " "), strings.Join(wantSorted, " "))
	}
	for _, key := range exUntickedKeys(got.Changes) {
		if row := dfxRow(t, again.Changes, key); row.DefaultSelected {
			t.Errorf("the leftover row %s arrives ticked, want a removal nobody ticked to stay unticked", key)
		}
	}
	// Nothing the manager agreed to is still on the list: a field, a position or a
	// person would mean the import wrote nothing.
	for _, kind := range []string{kindUpdate, kindMove, kindAssign, kindAssignDelete,
		kindMilestoneCreate, kindMilestoneUpdate, kindMilestoneDelete} {
		if c := dfxCount(again.Changes, kind); c != 0 {
			t.Errorf("%d %s rows left after the import, want none", c, kind)
		}
	}
}

// exUntickedKeys is what the wizard leaves for the manager to decide on its own:
// the rows it does not select.
func exUntickedKeys(changes []Change) []string {
	var out []string
	for _, c := range changes {
		if !c.DefaultSelected {
			out = append(out, c.Key)
		}
	}
	return out
}

// ── The answers around the ticks ─────────────────────────────────────────────

// TestExchange_ApplyRejections: the two answers a caller of the route needs and
// the applier's own tests do not cover from HTTP (they pin the logic, not the
// envelope). A base that no longer describes the project is a 409 nobody can tick
// their way out of, and a selection resting on a create it does not ask for is a
// 422 naming both keys, so the wizard can highlight the rows it means.
func TestExchange_ApplyRejections(t *testing.T) {
	e := exFixture(t)
	f, pid := e.f, e.pid
	x := exMount(t, f)
	file := exGanFile(t, "partner_edited.gan")
	name := "partner_edited.gan"

	got := exRoutePreview(t, x, f.caller(e.mgr), pid, name, file)

	t.Run("a selection resting on an unticked create", func(t *testing.T) {
		// The dependency on the row the file invented, without that row's create.
		dep := exDepKey(ganFramingRef, "new:7", false)
		code, body := exApplyRoute(t, x, f.caller(e.mgr), pid, name, file, got.Base, []string{dep})
		if code != http.StatusUnprocessableEntity {
			t.Fatalf("apply of %s alone: %d %v, want 422", dep, code, body)
		}
		_, fields := exErrFields(t, body)
		for _, want := range []string{dep, "new:7"} {
			if !slices.Contains(fields, want) {
				t.Errorf("fields = %s, want it to name %s", strings.Join(fields, " "), want)
			}
		}
		// Nothing was written: the batch is refused before the first row.
		if n := exCountNamed(t, f, "Safety inspection"); n != 0 {
			t.Errorf("the refused batch created the task %d times", n)
		}
	})

	t.Run("a stale base", func(t *testing.T) {
		code, body := exApplyRoute(t, x, f.caller(e.mgr), pid, name, file, got.Base, exDefaultKeys(got.Changes))
		if code != http.StatusOK {
			t.Fatalf("apply: %d %v, want 200", code, body)
		}
		// The same base again: the project these rows were reviewed against is gone.
		code, body = exApplyRoute(t, x, f.caller(e.mgr), pid, name, file, got.Base, exDefaultKeys(got.Changes))
		if code != http.StatusConflict {
			t.Fatalf("apply with the base of a project that has changed: %d %v, want 409", code, body)
		}
		if got := exErr(t, body); got != "PROJECT_CHANGED" {
			t.Errorf("code = %s, want PROJECT_CHANGED", got)
		}
	})
}

// ── Refused files ────────────────────────────────────────────────────────────

// TestExchange_InvalidFile: a partner attaches the wrong thing. The answer is
// about the file, in a code the wizard can print, and nothing is written.
func TestExchange_InvalidFile(t *testing.T) {
	e := exFixture(t)
	f, pid := e.f, e.pid
	x := exMount(t, f)
	png := []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06")

	for _, action := range []string{"preview", "apply"} {
		code, body := exPostFile(t, x, f.caller(e.mgr),
			"project/"+pid.String()+"/exchange/gan/"+action, "screenshot.png", png, "", nil)
		if code != http.StatusUnprocessableEntity {
			t.Errorf("%s of a PNG: %d %v, want 422", action, code, body)
		}
		if got := exErr(t, body); got != "INVALID_FILE" {
			t.Errorf("%s of a PNG: code %s, want INVALID_FILE", action, got)
		}
	}

	// No file part at all is the same answer: it is the request's file that is wrong.
	code, body := exPostFile(t, x, f.caller(e.mgr),
		"project/"+pid.String()+"/exchange/gan/preview", "", nil, "", nil)
	if code != http.StatusUnprocessableEntity || exErr(t, body) != "INVALID_FILE" {
		t.Errorf("preview with no file: %d %v, want 422 INVALID_FILE", code, body)
	}

	// A file EERP refuses leaves the project exactly as it was.
	_, same, warns := exPreview(t, f, pid, e.basic)
	dfxWantEmpty(t, same, warns)

	t.Run("an unknown format is refused before the file is read", func(t *testing.T) {
		// 404 like the export: the format is part of the URL, and nothing about the
		// upload has been looked at yet.
		code, body := exPostFile(t, x, f.caller(e.mgr),
			"project/"+pid.String()+"/exchange/xyz/preview", "partner_edited.gan", exGanFile(t, "partner_edited.gan"), "", nil)
		if code != http.StatusNotFound {
			t.Errorf("preview as .xyz: %d %v, want 404", code, body)
		}
	})
}

// TestExchange_TooManyTasks (Review Focus 4): the body cap is generous, so the
// ceiling that protects the database is the task count, and it has to answer 422
// rather than start a five thousand row transaction.
func TestExchange_TooManyTasks(t *testing.T) {
	e := exFixture(t)
	f, pid := e.f, e.pid
	x := exMount(t, f)
	file := exBigGan(t, ganMaxTasks+1)

	for _, action := range []string{"preview", "apply"} {
		code, body := exPostFile(t, x, f.caller(e.mgr),
			"project/"+pid.String()+"/exchange/gan/"+action, "big.gan", file, "", nil)
		if code != http.StatusUnprocessableEntity {
			t.Errorf("%s of a %d task file: %d %v, want 422", action, ganMaxTasks+1, code, body)
		}
		if got := exErr(t, body); got != "TOO_MANY_TASKS" {
			t.Errorf("%s of a %d task file: code %s, want TOO_MANY_TASKS", action, ganMaxTasks+1, got)
		}
	}

	// A file at the ceiling is still a plan somebody can review, so the refusal is
	// the ceiling and not a wall around the route.
	if got := exRoutePreview(t, x, f.caller(e.mgr), pid, "at-the-cap.gan", exBigGan(t, ganMaxTasks)); got.Base == "" {
		t.Error("a file of exactly the ceiling came back without a base")
	}

	// The project is the file it was, and an ordinary import still works afterwards.
	_, same, warns := exPreview(t, f, pid, e.basic)
	dfxWantEmpty(t, same, warns)
	if got := exRoutePreview(t, x, f.caller(e.mgr), pid, "partner_edited.gan", exGanFile(t, "partner_edited.gan")); len(got.Changes) != 5 {
		t.Errorf("after a refused giant file the preview holds %d rows, want the partner file's 5", len(got.Changes))
	}
}

// TestExchange_RemovalDependents: a removal row has to say what it takes with it
// before anyone ticks it. The count is a query the preview makes, so the wizard
// can print "2 timesheets" without asking per row.
func TestExchange_RemovalDependents(t *testing.T) {
	e := exFixture(t)
	f, pid := e.f, e.pid
	x := exMount(t, f)
	excavation := uuid.MustParse(ganExcavationRef)
	f.timesheet(pid, excavation, 3)
	f.timesheet(pid, excavation, 2)
	risk := f.id(`INSERT INTO project_risk (tenant_id, project_id, name, impact_on, likelihood, detectability, severity)
		VALUES ($1, $2, 'Concrete too late', 'quality', 2, 1, 3) RETURNING id`, f.tenant, pid)
	f.exec(`INSERT INTO project_risk_task (tenant_id, project_id, risk_id, task_id) VALUES ($1, $2, $3, $4)`,
		f.tenant, pid, risk, excavation)
	// A soft-deleted one is not data the removal loses.
	f.exec(`INSERT INTO project_timesheet (tenant_id, project_id, task_id, user_id, date, hours, deleted_at)
		VALUES ($1, $2, $3, $4, now(), 8, now())`, f.tenant, pid, excavation, uuid.New())

	file := exWithout(e.basic, "Excavation")
	got := exRoutePreview(t, x, f.caller(e.mgr), pid, "no-excavation.gan", exEncodeGan(t, file))
	row := dfxRow(t, got.Changes, changeKey(ganExcavationRef, "delete"))
	if row.Dependents == nil {
		t.Fatal("the removal row says nothing about what it takes with it")
	}
	if *row.Dependents != (Dependents{Timesheets: 2, RiskLinks: 1}) {
		t.Errorf("dependents = %+v, want the two live timesheets and the one risk link", *row.Dependents)
	}

	// Only the rows that destroy something carry the count: a field row asks for no
	// such weighing.
	for _, c := range got.Changes {
		if c.Kind != kindDelete && c.Dependents != nil {
			t.Errorf("row %s (%s) carries a dependents count, want it only on a removal", c.Key, c.Kind)
		}
	}
}

// ── Building files ───────────────────────────────────────────────────────────

// exEncodeGan writes a plan the way a partner's file would arrive, so a test can
// hand the route a plan it built rather than only the fixtures on disk.
func exEncodeGan(t *testing.T, p Plan) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := (ganFormat{}).Encode(&buf, p); err != nil {
		t.Fatalf("Encode: %v", err)
	}
	return buf.Bytes()
}

// exBigGan is a file with n rows, none of them carrying an EERP identity: the
// shape of a plan somebody drew from scratch, and the biggest file the exchange
// can be handed.
func exBigGan(t *testing.T, n int) []byte {
	t.Helper()
	start := time.Date(2026, time.January, 5, 0, 0, 0, 0, time.UTC)
	p := Plan{Name: "The big one", Weekend: DefaultWeekend}
	for i := range n {
		p.Tasks = append(p.Tasks, PlanTask{
			FileID:   strconv.Itoa(i + 1),
			Name:     fmt.Sprintf("Task %d", i+1),
			Start:    start,
			Duration: 1,
		})
	}
	return exEncodeGan(t, p)
}
