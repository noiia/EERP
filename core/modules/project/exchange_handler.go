package project

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"regexp"
	"strings"

	"core/internal/auth"
	"core/orm"
	"core/orm/access"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

// The three routes of the wizard (spec "API"): the download, the review list, and
// the import. Everything they need is already in the exchange layer; what lives
// here is the part only a route owes a browser: who gets through, what a refused
// file looks like, and the base the apply has to be handed back with.
//
// Two gates, and they are different because the calls are different.
//
// The export is a READ of the project's own schedule, so anyone who can see the
// project can download it, and an invisible project is a 404 rather than a 403:
// loadPlan and exportPlan filter on the tenant and not on the row scope, so the
// route is the only place that gate can live.
//
// The preview and the apply WRITE (the apply immediately, the preview as its
// necessary first step: nobody is shown a list they cannot act on), so they belong
// to the people who run the project. Visible but not its manager is a 403, which
// tells a reader nothing they were not allowed to know, and invisible is a 404.
//
// A file is never read before the format is known: an unknown :format is a 404,
// because the request asked for a route EERP does not have, and there is nothing
// about the upload that has been looked at yet to refuse.

// exchangeContentType is what a plan file is served as. GanttProject's .gan is
// XML, and it is the only file family registered; a second format adds a method to
// Format rather than a second value here.
const exchangeContentType = "application/xml"

// The two refusals about the upload itself. Both are 422 with the file named as
// the field, which is what the wizard highlights: a partner attaches the wrong
// thing, or the right thing drawn too large.
var (
	errInvalidFile = &rejection{status: http.StatusUnprocessableEntity, code: "INVALID_FILE",
		msg: "the file is not a plan EERP can read", fields: []string{"file"}}
	errTooManyTasks = &rejection{status: http.StatusUnprocessableEntity, code: "TOO_MANY_TASKS",
		msg: fmt.Sprintf("a file may hold at most %d tasks", ganMaxTasks), fields: []string{"file"}}
)

// previewAnswer is what the review list comes back as. Base is the hash of the
// very plan the rows were computed from, and the apply has to come back with it:
// a preview that handed out the hash of a differently read plan would make every
// apply answer 409 (see ruling 8 and loadPlan).
type previewAnswer struct {
	Base     string    `json:"base"`
	Changes  []Change  `json:"changes"`
	Warnings []Warning `json:"warnings"`
}

// upload is one posted file with the two things the wizard sends back beside it.
// The keys arrive as repeated form fields, which is what a browser's checkbox
// group posts, and the base as a hidden field.
type upload struct {
	file     Plan
	warnings []Warning
	filename string
	base     string
	keys     []string
}

// exchangeCall is one exchange request after the part every route does the same:
// the caller, the project, the format, and the answer for someone who has no
// business being here.
type exchangeCall struct {
	h      *Handler
	ctx    context.Context
	tenant uuid.UUID
	user   uuid.UUID
	pid    uuid.UUID
	format Format
}

// exchangeCall resolves the request, or the error the route answers with. An
// unknown format is answered before the project is read and before the file is
// touched.
func (h *Handler) exchangeCall(c *echo.Context) (*exchangeCall, error) {
	ctx := c.Request().Context()
	who, ok := auth.IdentityFromContext(ctx)
	if !ok {
		return nil, errNoCaller
	}
	tenant, _ := access.TenantFromContext(ctx)
	id, err := echo.PathParam[uuid.UUID](c, "id")
	if err != nil {
		return nil, echo.NewHTTPError(http.StatusBadRequest, "invalid id format")
	}
	key, err := echo.PathParam[string](c, "format")
	if err != nil {
		return nil, errNotFound
	}
	format, ok := formatByKey(key)
	if !ok {
		return nil, errNotFound
	}
	seen, err := orm.CanSeeRecord(ctx, h.db, "project", id)
	if err != nil {
		return nil, err
	}
	if !seen {
		return nil, errNotFound
	}
	return &exchangeCall{h: h, ctx: ctx, tenant: tenant, user: who.UserID, pid: id, format: format}, nil
}

// mustManage is the import's gate: the project's manager or a project admin, and
// nobody else. The project is already known visible, so a refusal here is a 403:
// the caller may read this project, and what they may not do is change it.
func (r *exchangeCall) mustManage() error {
	can, err := r.h.manages(r.ctx, r.tenant, r.user, r.pid)
	if err != nil {
		return err
	}
	if !can {
		return errForbidden
	}
	return nil
}

// ExportExchange handles GET /api/v1/project/:id/exchange/:format/export: the
// project as a file. It is served from the plan exportPlan reads (EERP's own
// calendar and the project's label, unlike a preview's), encoded by the format,
// and named after the project so a manager finds it again in a downloads folder.
func (h *Handler) ExportExchange(c *echo.Context) error {
	r, err := h.exchangeCall(c)
	if err != nil {
		return respond(c, err)
	}
	plan, err := exportPlan(r.ctx, h.db, r.tenant, r.pid)
	if errors.Is(err, orm.ErrNotFound) {
		return respond(c, errNotFound)
	}
	if err != nil {
		return err
	}
	markCollapsed(plan.Tasks, c.QueryParam("collapsed"))
	var buf bytes.Buffer
	if err := r.format.Encode(&buf, plan); err != nil {
		return err
	}
	name := exchangeFilename(plan.Name) + r.format.Ext()
	c.Response().Header().Set("Content-Disposition", exchangeDisposition(name))
	return c.Stream(http.StatusOK, exchangeContentType, bytes.NewReader(buf.Bytes()))
}

// markCollapsed flags the tasks named in `collapsed` (comma-separated task uuids,
// the rows folded in the user's Gantt) so the file opens with them folded too.
// Unknown ids are ignored: it is a display hint, not a selection.
func markCollapsed(tasks []PlanTask, collapsed string) {
	if collapsed == "" {
		return
	}
	ids := map[string]bool{}
	for _, id := range strings.Split(collapsed, ",") {
		ids[strings.TrimSpace(id)] = true
	}
	for i := range tasks {
		if !tasks[i].Milestone && ids[tasks[i].Ref] {
			tasks[i].Collapsed = true
		}
	}
}

// PreviewExchange handles POST /api/v1/project/:id/exchange/:format/preview: the
// review list, and the base the apply must carry.
//
// The project is read on the FILE's calendar, not EERP's: a duration is a
// working-day count, so the file's weekend is the only mask under which the two
// plans' durations mean the same thing (loadPlan). The base is the hash of that
// same plan, so the apply compares what the manager was shown.
func (h *Handler) PreviewExchange(c *echo.Context) error {
	r, err := h.exchangeCall(c)
	if err != nil {
		return respond(c, err)
	}
	if err := r.mustManage(); err != nil {
		return respond(c, err)
	}
	up, err := r.upload(c)
	if err != nil {
		return respond(c, err)
	}
	users, err := exchangeUsers(r.ctx, h.db, r.tenant)
	if err != nil {
		return err
	}
	cur, err := loadPlan(r.ctx, h.db, r.tenant, r.pid, up.file.Weekend)
	if errors.Is(err, orm.ErrNotFound) {
		return respond(c, errNotFound)
	}
	if err != nil {
		return err
	}
	changes, warnings := diffPlans(cur, up.file, users)
	if err := r.fillDependents(changes, removalKeys(cur)); err != nil {
		return err
	}
	// The file's own warnings first: they are about what the partner sent, and are
	// the half of the answer they can still fix in their own planner. Both lists
	// arrive empty, never null, so the wizard has one shape to read.
	if changes == nil {
		changes = []Change{}
	}
	all := make([]Warning, 0, len(up.warnings)+len(warnings))
	all = append(all, up.warnings...)
	all = append(all, warnings...)
	return c.JSON(http.StatusOK, previewAnswer{Base: planHash(cur), Changes: changes, Warnings: all})
}

// ApplyExchange handles POST /api/v1/project/:id/exchange/:format/apply: the
// manager's ticks, turned into rows. The file goes up again, because the rows are
// only ever meaningful against the plan they were diffed from, and the base is
// what says the project is still that plan.
func (h *Handler) ApplyExchange(c *echo.Context) error {
	r, err := h.exchangeCall(c)
	if err != nil {
		return respond(c, err)
	}
	if err := r.mustManage(); err != nil {
		return respond(c, err)
	}
	up, err := r.upload(c)
	if err != nil {
		return respond(c, err)
	}
	users, err := exchangeUsers(r.ctx, h.db, r.tenant)
	if err != nil {
		return err
	}
	n, err := h.applyPlan(r.ctx, r.tenant, r.pid, up.file, up.base, up.keys, users, up.filename)
	if err != nil {
		return respond(c, err)
	}
	return c.JSON(http.StatusOK, map[string]int{"applied": n})
}

// ── The upload ───────────────────────────────────────────────────────────────

// upload reads the posted file and decodes it as the request's format.
//
// A file that is not the format, and a request that carries no file at all, are
// the same answer: it is the request's file that is wrong. The task ceiling is
// checked on the raw bytes as well as on the decoded plan, because the .gan
// decoder refuses an oversized file with the very error a screenshot answers with
// (gan.go's ganMaxTasks), and a manager has to be told their plan is too big
// rather than that they attached a PNG.
func (r *exchangeCall) upload(c *echo.Context) (*upload, error) {
	form, err := c.MultipartForm()
	if err != nil {
		return nil, errInvalidFile
	}
	files := form.File["file"]
	if len(files) == 0 {
		return nil, errInvalidFile
	}
	raw, err := readUpload(files[0])
	if err != nil {
		return nil, fmt.Errorf("read upload: %w", err)
	}
	plan, warnings, err := r.format.Decode(bytes.NewReader(raw))
	if err != nil {
		if countTasks(raw) > ganMaxTasks {
			return nil, errTooManyTasks
		}
		return nil, errInvalidFile
	}
	if len(plan.Tasks) > ganMaxTasks {
		return nil, errTooManyTasks
	}
	up := &upload{file: plan, warnings: warnings, filename: files[0].Filename}
	if v := form.Value["base"]; len(v) > 0 {
		up.base = v[0]
	}
	up.keys = form.Value["keys"]
	return up, nil
}

// readUpload takes an uploaded part into memory. Its size is already bounded by
// the route's body limit (app.go's uploadLimit, with the route exempt from the
// server's small default), so this is a copy, not a risk.
func readUpload(fh *multipart.FileHeader) ([]byte, error) {
	f, err := fh.Open()
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	return io.ReadAll(f)
}

// countTasks is how many <task> elements a file holds, counted on its bytes.
//
// It exists for one reason: the ceiling and "this is not a .gan file" share an
// error inside the decoder, and the route has to tell the two apart. Counting the
// elements the format itself counts (gan.go's ganMaxTasks is tasks plus
// milestones, and both are <task> elements) is the only reading of a file the
// handler is allowed when its own decoder has already refused to look at it.
//
// shortcut: "<task>" is .gan's word for a row, and it is the one format notion
// this generic handler holds; when a second Format lands, have Decode return a
// distinct over-the-ceiling error (or a Count method on Format) and delete this.
func countTasks(raw []byte) int {
	dec := xml.NewDecoder(bytes.NewReader(raw))
	var n int
	for {
		tok, err := dec.Token()
		if err != nil {
			return n
		}
		if se, ok := tok.(xml.StartElement); ok && se.Name.Local == "task" {
			n++
		}
	}
}

// ── What a removal takes with it ─────────────────────────────────────────────

// removalKeys indexes the plan's tasks by the key a removal of each one carries,
// so the preview can name the rows it is counting without taking a key apart: the
// applier's indexRows discipline (a key is built the same way the diff builds it
// and then looked up, never split).
func removalKeys(cur Plan) map[string]uuid.UUID {
	out := map[string]uuid.UUID{}
	for _, t := range cur.Tasks {
		if t.Milestone {
			continue
		}
		id, err := uuid.Parse(t.Key())
		if err != nil {
			// A row with no id behind it is a hand built plan's oddity: no removal
			// of the database's answers to it, so there is nothing to count.
			continue
		}
		out[changeKey(t.Key(), "delete")] = id
	}
	return out
}

// fillDependents puts the count on every removal row, so the wizard can print
// "2 timesheets, 1 risk link" before anyone ticks it. One query per count for the
// whole list (removalDependents), and only the rows that destroy something are
// weighed: a field row asks for no such count.
func (r *exchangeCall) fillDependents(changes []Change, byKey map[string]uuid.UUID) error {
	var ids []uuid.UUID
	for _, c := range changes {
		if c.Kind != kindDelete {
			continue
		}
		if id, ok := byKey[c.Key]; ok {
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	counts, err := removalDependents(r.ctx, r.h.db, r.tenant, ids)
	if err != nil {
		return err
	}
	for i := range changes {
		if changes[i].Kind != kindDelete {
			continue
		}
		id, ok := byKey[changes[i].Key]
		if !ok {
			continue
		}
		n := counts[id]
		changes[i].Dependents = &n
	}
	return nil
}

// ── The file's name ──────────────────────────────────────────────────────────

var (
	// filenameJunk is everything a download's name cannot carry: a slash would put
	// the file somewhere else, or nowhere, and a control character would break the
	// response's own header. Letters and digits of any script stay, because the
	// name is how a manager finds their own file again in a downloads folder.
	filenameJunk = regexp.MustCompile(`[^\p{L}\p{N} ._-]+`)
	// filenameSpace collapses the runs of spaces the removal above leaves behind.
	filenameSpace = regexp.MustCompile(`\s+`)
)

// exchangeFilename keeps a project's name inside what a filesystem accepts: the
// name of a download comes from a string a manager typed, and it is the one part
// of the response the wizard cannot help them with. What survives is the
// findable part of the name, not an encoding of it, and a project named with
// nothing but path separators is still the project: it is called project.gan.
//
// The alphabet it keeps holds no character a quoted string would have to escape,
// which is what exchangeDisposition hands it to, unescaped.
func exchangeFilename(name string) string {
	n := filenameSpace.ReplaceAllString(filenameJunk.ReplaceAllString(name, ""), " ")
	if n = strings.Trim(n, " .-"); n == "" {
		return "project"
	}
	return n
}

// exchangeDisposition is the download's header: one quoted filename parameter.
//
// It is built by hand rather than through mime.FormatMediaType because that helper
// leaves a name that is a legal token unquoted ("filename=project.gan") and quotes
// one with a space in it, so the same download would be announced two different
// ways depending on what the project is called. A wizard, and a browser's save
// dialog, do better with one shape.
func exchangeDisposition(name string) string {
	return `attachment; filename="` + name + `"`
}
