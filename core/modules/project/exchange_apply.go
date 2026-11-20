package project

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"

	"core/internal/auth"
	"core/internal/chatter"
	"core/orm"
	"core/orm/model"

	"github.com/google/uuid"
)

// The import: a manager reviewed a partner's file, ticked the rows they agree with,
// and this is where those ticks become rows.
//
// Three promises hold here, and everything else is detail.
//
// The same rules run as on any other write. Every row goes through h.check, the very
// functions Mount puts in front of the generic CRUD writes, so an import cannot put a
// task in another project's stage, or close a loop in the dependencies, any more than
// a POST can. A refused row comes back naming the row the manager ticked, which is
// the only thing they recognise.
//
// One transaction, or none. The project row is locked FOR UPDATE, the base the preview
// handed out is re-derived from the locked project, and every write runs on the one
// transaction: a batch that is refused halfway leaves the project exactly as it was,
// activity log included.
//
// The ticks are a set, not a program. A manager ticks rows in any order and the result
// must be the same, so the phases below are fixed by what the database needs (a task
// before the rows that hang off it, removals last) and never by the order of the keys;
// a write against a row the same batch is deleting is dropped rather than answered as
// a 404 about a row that is on its way out anyway.

// conflictChanged is the base the preview handed out no longer describing the project:
// someone worked on it while the manager was reading the list. 409, not 422: nothing
// the manager can tick fixes it, they have to look at the project again.
var conflictChanged = &rejection{status: http.StatusConflict, code: "PROJECT_CHANGED",
	msg: "the project changed since the file was reviewed: preview it again"}

// applyPlan carries out the ticked rows of a preview, and returns how many it applied.
//
// base is the hash the preview returned for the same file, and keys the change keys the
// manager ticked. users is the tenant's live staff by lower(email), the same map the
// preview resolved the file's assignees against: a person who appeared since the
// preview cannot be added here, which is the point.
//
// The caller comes from ctx (the rules read it for their visibility checks), so this is
// only ever called behind the route's own gate.
func (h *Handler) applyPlan(ctx context.Context, tenant, pid uuid.UUID, file Plan,
	base string, keys []string, users map[string]uuid.UUID, filename string) (int, error) {
	who, ok := auth.IdentityFromContext(ctx)
	if !ok {
		return 0, errNoCaller
	}
	var applied int
	err := orm.Transact(ctx, h.db, func(tx *orm.Tx) error {
		// Lock the project: the base must describe the state these writes land on, and
		// two managers importing at once must not both believe the preview they were
		// given (the shape baseline.go's CreateBaseline uses for the same reason).
		var locked bool
		if err := tx.QueryRow(ctx, `SELECT true FROM project
			WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL FOR UPDATE`, pid, tenant).Scan(&locked); err != nil {
			return err
		}
		if !locked {
			return errNotFound
		}
		// The FILE's calendar, as the preview read it: any other weekend and the hash
		// is of a plan nobody compared.
		cur, err := loadPlan(ctx, tx, tenant, pid, file.Weekend)
		if err != nil {
			return err
		}
		if planHash(cur) != base {
			return conflictChanged
		}
		a, err := newApplier(h, ctx, tx, tenant, pid, cur, file, users, keys)
		if err != nil {
			return err
		}
		n, err := a.run()
		if err != nil {
			return err
		}
		applied = n
		if n == 0 {
			// Nothing done, nothing to say: an empty log line would be noise.
			return nil
		}
		return a.log(who, filename, n)
	})
	if err != nil {
		return 0, err
	}
	return applied, nil
}

// ── The batch ────────────────────────────────────────────────────────────────

// applier is one reviewed selection about to become rows: the comparison it was drawn
// from, the rows ticked, and the identities the batch invents as it goes.
type applier struct {
	h      *Handler
	ctx    context.Context
	tx     *orm.Tx
	tenant uuid.UUID
	pid    uuid.UUID
	d      *diff
	rows   []Change

	want map[string]bool
	// taskRows and mileRows are every row the project holds, indexed by each of the
	// keys a change about it can carry. A key is a string the diff built by
	// concatenation, and the ends of a dependency hold colons of their own, so apply
	// never takes one apart: it builds the same keys the same way and looks them up.
	taskRows map[string]uuid.UUID
	mileRows map[string]uuid.UUID
	// newTask and newMile remember the ids this batch invented, so a dependency on a
	// task the file added can be written after it.
	newTask map[string]uuid.UUID
	newMile map[string]uuid.UUID
	// gone is every task this batch deletes. It is worked out before the first write
	// so that a write aimed at a doomed row can be dropped however the ticks came.
	gone map[uuid.UUID]bool
	// pendingGates are the tasks this batch created whose deliverable is a milestone
	// the same batch has not written yet: the phase order puts the task creates
	// before the milestone creates, so those links wait for linkPendingGates.
	pendingGates []pendingGate

	applied int
}

// pendingGate is one created task waiting for the milestone its create named: the row
// to write, the create the manager ticked (which is what a refusal has to name), and
// the milestone's key as the diff built it.
type pendingGate struct {
	task uuid.UUID
	key  string
	gate string
}

// fieldKeys are the keys a row about a task or a milestone can arrive under: the fields
// the diff reports, plus the two decisions that are not fields.
var (
	taskFieldKeys = []string{fieldName, fieldDates, fieldHours, fieldClosed, fieldMilestoneID, "move", "delete"}
	mileFieldKeys = []string{fieldName, fieldDates, "delete"}
)

// newApplier takes the comparison the manager was shown, keeps the rows they ticked, and
// refuses the selection before a single write if a key was never offered or asks for a
// row without the row it needs.
//
// The diff is rebuilt here rather than handed in: the keys to resolve are the ones the
// diff itself chose (fileKey, with its new:<id>#<n> disambiguation), and rebuilding it
// from the same two plans is the only way to be sure of that. The base was just checked
// against the locked project, so this is the same comparison the preview made.
func newApplier(h *Handler, ctx context.Context, tx *orm.Tx, tenant, pid uuid.UUID,
	cur, file Plan, users map[string]uuid.UUID, keys []string) (*applier, error) {
	d := &diff{cur: cur, file: file, users: users}
	rows, _ := d.run()

	want, err := selection(rows, keys)
	if err != nil {
		return nil, err
	}
	a := &applier{h: h, ctx: ctx, tx: tx, tenant: tenant, pid: pid, d: d, want: want,
		taskRows: map[string]uuid.UUID{}, mileRows: map[string]uuid.UUID{},
		newTask: map[string]uuid.UUID{}, newMile: map[string]uuid.UUID{},
		gone: map[uuid.UUID]bool{}}
	a.indexRows(cur)
	// The rows being deleted, before any write: a later row of the same batch aimed at
	// one of them is dropped, whichever way the ticks came in.
	kinds := make(map[string]string, len(rows))
	for _, c := range rows {
		kinds[c.Key] = c.Kind
	}
	for _, k := range keys {
		if kinds[k] != kindDelete {
			continue
		}
		if id, ok := a.taskRows[k]; ok {
			a.gone[id] = true
		}
	}
	for _, c := range rows {
		if a.want[c.Key] {
			a.rows = append(a.rows, c)
		}
	}
	return a, nil
}

// selection is the manager's ticks as a set, refused if one was never on the list or
// asks for a row whose companion is missing.
func selection(rows []Change, keys []string) (map[string]bool, error) {
	want := make(map[string]bool, len(keys))
	for _, k := range keys {
		want[k] = true
	}
	offered := make(map[string]Change, len(rows))
	for _, c := range rows {
		offered[c.Key] = c
	}
	for _, k := range keys {
		c, ok := offered[k]
		if !ok {
			// A stale wizard, or a hand built request. Naming the key is the whole
			// answer: the manager can unselect what they were not shown.
			return nil, invalid(k, "the preview did not offer "+k)
		}
		for _, req := range c.Requires {
			if !want[req] {
				return nil, &rejection{status: http.StatusUnprocessableEntity, code: "VALIDATION_ERROR",
					msg: c.Key + " cannot be applied without " + req, fields: []string{k, req}}
			}
		}
	}
	return want, nil
}

// indexRows indexes every row the project holds by each of the keys a change about it
// can carry, so a ticked key is looked up rather than taken apart.
func (a *applier) indexRows(cur Plan) {
	for _, t := range cur.Tasks {
		id, err := uuid.Parse(strings.TrimPrefix(t.Key(), milestoneRefPrefix))
		if err != nil {
			// A key with no id behind it is a hand built plan's oddity: no row of the
			// database answers to it, so there is nothing to write.
			continue
		}
		fields, into := taskFieldKeys, a.taskRows
		if t.Milestone {
			fields, into = mileFieldKeys, a.mileRows
		}
		for _, f := range fields {
			into[changeKey(t.Key(), f)] = id
		}
	}
}

// run carries out the ticked rows in the database's own order and says how many landed.
// The order is the brief's, and the one step that is not a phase of its own
// (linkPendingGates) only finishes a write an earlier phase had to leave half done.
func (a *applier) run() (int, error) {
	for _, phase := range []func() error{
		a.createTasks,
		a.createMilestones,
		a.linkPendingGates,
		a.placeTasks,
		a.updateTasks,
		a.updateMilestones,
		a.linkTasks,
		a.removeRows,
	} {
		if err := phase(); err != nil {
			return 0, err
		}
	}
	return a.applied, nil
}

// each calls fn for every ticked row of these kinds, in the order the wizard showed
// them. A row whose target the batch has already decided to delete is left alone, which
// is what makes the ticks order-blind.
func (a *applier) each(fn func(Change) error, kinds ...string) error {
	for _, c := range a.rows {
		if !a.want[c.Key] || !slices.Contains(kinds, c.Kind) {
			continue
		}
		if err := fn(c); err != nil {
			return err
		}
	}
	return nil
}

// ── The phases ───────────────────────────────────────────────────────────────

func (a *applier) createTasks() error {
	return a.each(func(c Change) error {
		i, ok := a.d.fileIdxByKey[c.Key]
		if !ok {
			return nil
		}
		id, err := a.createTask(c, a.d.file.Tasks[i])
		if err != nil {
			return err
		}
		if id == uuid.Nil {
			return nil
		}
		a.newTask[c.Key] = id
		a.applied++
		return nil
	}, kindCreate)
}

// createTask writes one task the file added. Its dates are the file's own: Start, and
// the duration counted out on the file's calendar (the same endAfter the diff counted
// with, which is why an import of an untouched file would have written nothing).
//
// A deliverable this same batch adds (the file's milestone and the task naming it came
// in together) cannot be resolved here: the milestone creates run in the next phase, so
// the task goes in without the column and linkPendingGates writes it once the row
// exists. Anything else the row names has to resolve now, or the ticked row is refused.
func (a *applier) createTask(c Change, t PlanTask) (uuid.UUID, error) {
	value, _ := c.After.(createValue)
	body := map[string]any{
		"project_id":    a.pid.String(),
		"name":          t.Name,
		"planned_hours": t.PlannedHours,
		"date_start":    day(t.Start),
		"deadline":      day(endAfter(t.Start, t.Duration, a.d.file.Weekend)),
	}
	parent, skip, err := a.createParent(c, value)
	if err != nil || skip {
		return uuid.Nil, err
	}
	if parent != uuid.Nil {
		body["parent_id"] = parent.String()
	}
	waiting := a.createGate(c, value, body)
	out, err := a.check("project_task", opCreate, uuid.Nil, body, c.Key)
	if err != nil {
		return uuid.Nil, err
	}
	var row ProjectTask
	if err := retype(out, &row); err != nil {
		return uuid.Nil, err
	}
	row.TenantID = a.tenant
	row.ID = uuid.New()
	// wbs_number and the roll-up columns are the triggers', whatever the rules left in
	// the body.
	row.WbsNumber = nil
	created, err := orm.MustRepo[ProjectTask](a.h.db).WithTx(a.tx).Create(a.ctx, row)
	if err != nil {
		return uuid.Nil, err
	}
	if waiting != "" {
		a.pendingGates = append(a.pendingGates, pendingGate{task: created.ID, key: c.Key, gate: waiting})
	}
	return created.ID, nil
}

// createParent is the parent column of a create: the row to hang the new task under.
// skip says the parent is itself going away in this batch, which makes the create a
// write against a doomed row: nothing is written and nothing is refused. A parent
// nothing resolves to is not a row of this project, so the ticked row is refused by its
// own key (Requires is what normally keeps a create's parent ticked too).
func (a *applier) createParent(c Change, value createValue) (uuid.UUID, bool, error) {
	if value.Parent == nil || *value.Parent == "" {
		return uuid.Nil, false, nil
	}
	id, ok := a.task(*value.Parent)
	if !ok {
		return uuid.Nil, false, invalid(c.Key,
			fmt.Sprintf("%s names parent %s, which is no task of this project", c.Key, *value.Parent))
	}
	if a.gone[id] {
		return uuid.Nil, true, nil
	}
	return id, false, nil
}

// createGate is the deliverable column of a create, and says which milestone key the
// link has to wait for: empty when the column went into the body, the key when it names
// a row this batch has not written yet.
func (a *applier) createGate(c Change, value createValue, body map[string]any) string {
	if value.MilestoneID == nil {
		return ""
	}
	if id, ok := a.milestone(value.MilestoneID.ID); ok {
		body["milestone_id"] = id.String()
		return ""
	}
	return value.MilestoneID.ID
}

func (a *applier) createMilestones() error {
	return a.each(func(c Change) error {
		i, ok := a.d.fileIdxByKey[c.Key]
		if !ok {
			return nil
		}
		t := a.d.file.Tasks[i]
		body := map[string]any{"project_id": a.pid.String(), "name": t.Name, "deadline": day(t.Start)}
		out, err := a.check("project_milestone", opCreate, uuid.Nil, body, c.Key)
		if err != nil {
			return err
		}
		var row ProjectMilestone
		if err := retype(out, &row); err != nil {
			return err
		}
		row.TenantID = a.tenant
		row.ID = uuid.New()
		created, err := orm.MustRepo[ProjectMilestone](a.h.db).WithTx(a.tx).Create(a.ctx, row)
		if err != nil {
			return err
		}
		a.newMile[c.Key] = created.ID
		a.applied++
		return nil
	}, kindMilestoneCreate)
}

// linkPendingGates writes the deliverable links the task creates had to leave out, now
// that the milestones they name exist: the rules run on the write as on any other, and
// the row is one this batch invented seconds ago, so it counts as the create that asked
// for it rather than as a change of its own.
//
// A key that still names nothing is a ticked row pointing at a deliverable neither the
// project nor the file holds, which the manager has a row to untick: 422 naming it, not
// a raw error the route would answer 500.
func (a *applier) linkPendingGates() error {
	for _, p := range a.pendingGates {
		id, ok := a.milestone(p.gate)
		if !ok {
			return invalid(p.key,
				fmt.Sprintf("%s names deliverable %s, which is no row of this project or of the file", p.key, p.gate))
		}
		body, err := a.check("project_task", opUpdate, p.task, map[string]any{"milestone_id": id.String()}, p.key)
		if err != nil {
			return err
		}
		if err := a.setTask(p.task, body); err != nil {
			return err
		}
	}
	a.pendingGates = nil
	return nil
}

// placeTasks is the position pass: a parent's children end up in the file's order.
//
// The list each group is placed from is the file's order restricted to the tasks that
// will actually be there, matched rows the batch is not deleting plus the creates it
// ticked. Only a ticked move or create is written: its sequence puts it at that
// position and the triggers shift and renumber the siblings around it, so the rows
// nobody ticked keep their relative order without being touched.
func (a *applier) placeTasks() error {
	for _, g := range a.groups() {
		var parentID any
		if g.parent != "" {
			id, ok := a.task(g.parent)
			if !ok || a.gone[id] {
				continue
			}
			parentID = id.String()
		}
		for n, s := range g.who {
			_, created := a.newTask[s.key]
			if !created && !a.want[changeKey(s.key, "move")] {
				continue
			}
			if err := a.moveTask(s.key, s.id, parentID, n+1); err != nil {
				return err
			}
			if !created {
				a.applied++
			}
		}
	}
	return nil
}

// sibling is one task about to be placed under a parent, and siblingGroup the parent
// with its children in the order the file lists them.
type sibling struct {
	key string
	id  uuid.UUID
}

type siblingGroup struct {
	parent string
	who    []sibling
}

// groups walks the file in its own order and gathers, per parent, the tasks that will
// actually be there once the batch is through: the matched rows it is not deleting, and
// the creates it ticked.
func (a *applier) groups() []siblingGroup {
	var out []siblingGroup
	at := map[string]int{}
	for i := range a.d.file.Tasks {
		if a.d.file.Tasks[i].Milestone {
			continue
		}
		id, ok := a.matched(i)
		if !ok {
			continue
		}
		parent := a.d.fileParent(i)
		n, seen := at[parent]
		if !seen {
			n = len(out)
			at[parent] = n
			out = append(out, siblingGroup{parent: parent})
		}
		out[n].who = append(out[n].who, sibling{key: a.d.fileRows[i].key, id: id})
	}
	return out
}

// matched is the row a file row will have after the batch: the one it matched, or the
// one its create wrote, and whether it survives at all.
func (a *applier) matched(i int) (uuid.UUID, bool) {
	row := a.d.fileRows[i]
	if row.matched {
		id, err := uuid.Parse(row.key)
		if err != nil || a.gone[id] {
			return uuid.Nil, false
		}
		return id, true
	}
	if !a.want[row.key] {
		return uuid.Nil, false
	}
	id, ok := a.newTask[row.key]
	return id, ok && !a.gone[id]
}

func (a *applier) moveTask(key string, id uuid.UUID, parentID any, sequence int) error {
	// A task this batch created has no move row of its own on the review list: the
	// manager ticked its create, so the create is the key a refused placement names
	// (changeKey on a new: key would answer a key the preview never offered).
	report := changeKey(key, "move")
	if _, created := a.newTask[key]; created {
		report = key
	}
	body := map[string]any{"parent_id": parentID, "sequence": sequence}
	out, err := a.check("project_task", opUpdate, id, body, report)
	if err != nil {
		return err
	}
	return a.setTask(id, out)
}

// updateTasks is the fields the file disagrees about. Each is one column (or the one
// column that means it: a closing is a stage move, because a task is closed by where it
// sits).
func (a *applier) updateTasks() error {
	return a.each(func(c Change) error {
		id, ok := a.taskRows[c.Key]
		if !ok || a.gone[id] {
			return nil
		}
		body, err := a.fieldBody(c)
		if err != nil {
			return err
		}
		if body == nil {
			return nil
		}
		out, err := a.check("project_task", opUpdate, id, body, c.Key)
		if err != nil {
			return err
		}
		if err := a.setTask(id, out); err != nil {
			return err
		}
		a.applied++
		return nil
	}, kindUpdate)
}

// fieldBody is the write a field row asks for, or nil when there is nothing to write
// (a deliverable pointing at a row this batch is deleting).
func (a *applier) fieldBody(c Change) (map[string]any, error) {
	switch c.Field {
	case fieldName:
		name, err := a.nameOf(c)
		if err != nil {
			return nil, err
		}
		return map[string]any{"name": name}, nil
	case fieldDates:
		return a.datesOf(c)
	case fieldHours:
		hours, ok := c.After.(float64)
		if !ok {
			return nil, badValue(c.Key, "hours", c.After)
		}
		return map[string]any{"planned_hours": hours}, nil
	case fieldClosed:
		return a.stageOf(c)
	case fieldMilestoneID:
		return a.milestoneOf(c)
	default:
		return nil, fmt.Errorf("project: %s reports field %s, which apply does not know", c.Key, c.Field)
	}
}

// badValue is the refusal of a row whose value is not the shape its field asks for: the
// diff builds every one of these, so a row like this is not a plan, and the manager
// still has to be told which row to untick. A raw error here would reach the route as a
// 500 naming no row at all.
func badValue(key, what string, v any) error {
	return invalid(key, fmt.Sprintf("%s holds %s of type %T", key, what, v))
}

// stageOf is the closing of a task, which EERP stores as the column it sits in: a task
// is closed by its stage, not by a flag of its own.
func (a *applier) stageOf(c Change) (map[string]any, error) {
	now, ok := c.After.(bool)
	if !ok {
		return nil, badValue(c.Key, "a completion", c.After)
	}
	stage, err := a.stage(c.Key, now)
	if err != nil {
		return nil, err
	}
	return map[string]any{"stage_id": stage}, nil
}

// milestoneOf is the deliverable a task produces. A file that names one this batch is
// deleting (or never created) leaves the task as it is: the row is on its way out, and
// guessing at another deliverable is the manager's call, not apply's.
func (a *applier) milestoneOf(c Change) (map[string]any, error) {
	value, _ := c.After.(*milestoneValue)
	if value == nil {
		return map[string]any{"milestone_id": nil}, nil
	}
	gate, ok := a.milestone(value.ID)
	if !ok || a.goneMilestone(gate) {
		return nil, nil
	}
	return map[string]any{"milestone_id": gate.String()}, nil
}

// nameOf is the name a field row carries.
func (a *applier) nameOf(c Change) (string, error) {
	name, ok := c.After.(string)
	if !ok {
		return "", badValue(c.Key, "a name", c.After)
	}
	return name, nil
}

// datesOf is the two columns the plan's dates live in: a task's own span.
func (a *applier) datesOf(c Change) (map[string]any, error) {
	value, ok := c.After.(datesValue)
	if !ok {
		return nil, badValue(c.Key, "dates", c.After)
	}
	start, err := time.Parse(exchangeDayLayout, value.Start)
	if err != nil {
		return nil, fmt.Errorf("project: %s starts %s: %w", c.Key, value.Start, err)
	}
	end, err := time.Parse(exchangeDayLayout, value.End)
	if err != nil {
		return nil, fmt.Errorf("project: %s ends %s: %w", c.Key, value.End, err)
	}
	return map[string]any{"date_start": day(start), "deadline": day(end)}, nil
}

// deadlineOf is the same for a deliverable, which is one day rather than a span.
func (a *applier) deadlineOf(c Change) (map[string]any, error) {
	value, ok := c.After.(datesValue)
	if !ok {
		return nil, badValue(c.Key, "dates", c.After)
	}
	deadline, err := time.Parse(exchangeDayLayout, value.Start)
	if err != nil {
		return nil, fmt.Errorf("project: %s reaches %s: %w", c.Key, value.Start, err)
	}
	return map[string]any{"deadline": day(deadline)}, nil
}

// mileFieldBody is the write a deliverable's field row asks for: a milestone is a name
// and one day, the two columns it carries.
func (a *applier) mileFieldBody(c Change) (map[string]any, error) {
	switch c.Field {
	case fieldName:
		name, err := a.nameOf(c)
		if err != nil {
			return nil, err
		}
		return map[string]any{"name": name}, nil
	case fieldDates:
		return a.deadlineOf(c)
	default:
		return nil, fmt.Errorf("project: %s reports field %s, which apply does not know", c.Key, c.Field)
	}
}

func (a *applier) updateMilestones() error {
	return a.each(func(c Change) error {
		id, ok := a.mileRows[c.Key]
		if !ok || a.goneMilestone(id) {
			return nil
		}
		body, err := a.mileFieldBody(c)
		if err != nil {
			return err
		}
		out, err := a.check("project_milestone", opUpdate, id, body, c.Key)
		if err != nil {
			return err
		}
		q := orm.MustRepo[ProjectMilestone](a.h.db).WithTx(a.tx).UpdateQuery().
			Where(orm.Cond("id = $1 AND tenant_id = $2 AND deleted_at IS NULL", id, a.tenant))
		for k, v := range out {
			q = q.Set(k, v)
		}
		if _, err := q.Set("updated_at", time.Now()).Exec(a.ctx, a.tx); err != nil {
			return err
		}
		a.applied++
		return nil
	}, kindMilestoneUpdate)
}

// linkTasks is the rows that hang off tasks: a new dependency, and a new assignee. Both
// need the task they name to exist, which is why they come after the creates.
func (a *applier) linkTasks() error {
	return a.each(func(c Change) error {
		switch c.Kind {
		case kindDependency:
			return a.addDependency(c)
		default:
			return a.addAssignee(c)
		}
	}, kindDependency, kindAssign)
}

func (a *applier) addDependency(c Change) error {
	value, ok := c.After.(depValue)
	if !ok {
		return badValue(c.Key, "a dependency", c.After)
	}
	pred, ok := a.task(value.Pred)
	if !ok {
		return nil
	}
	succ, ok := a.task(value.Succ)
	if !ok {
		return nil
	}
	if a.gone[pred] || a.gone[succ] {
		return nil
	}
	body := map[string]any{"task_id": succ.String(), "depends_on_id": pred.String()}
	out, err := a.check("project_task_dependency", opCreate, uuid.Nil, body, c.Key)
	if err != nil {
		return err
	}
	var row ProjectTaskDependency
	if err := retype(out, &row); err != nil {
		return err
	}
	row.TenantID = a.tenant
	row.ID = uuid.New()
	if _, err := orm.MustRepo[ProjectTaskDependency](a.h.db).WithTx(a.tx).Create(a.ctx, row); err != nil {
		return err
	}
	a.applied++
	return nil
}

func (a *applier) addAssignee(c Change) error {
	value, ok := c.After.(assignValue)
	if !ok {
		return badValue(c.Key, "an assignment", c.After)
	}
	task, ok := a.task(value.Task)
	if !ok || a.gone[task] {
		return nil
	}
	user, known := a.d.users[strings.ToLower(value.Email)]
	if !known {
		// The preview warned about this person and offered no row; a wizard that sent
		// one anyway gets nothing done rather than a guess.
		return nil
	}
	body := map[string]any{"task_id": task.String(), "user_id": user.String()}
	out, err := a.check("project_task_user", opCreate, uuid.Nil, body, c.Key)
	if err != nil {
		return err
	}
	var row ProjectTaskUser
	if err := retype(out, &row); err != nil {
		return err
	}
	row.TenantID = a.tenant
	row.ID = uuid.New()
	if _, err := orm.MustRepo[ProjectTaskUser](a.h.db).WithTx(a.tx).Create(a.ctx, row); err != nil {
		return err
	}
	a.applied++
	return nil
}

// removeRows is the destructive half, and it goes last so that every row the file still
// wants is in place before anything disappears. Removals are the manager's decision
// alone: nothing here deletes a row because a neighbour of it was deleted.
func (a *applier) removeRows() error {
	for _, phase := range []func() error{
		a.removeDependencies,
		a.removeAssignees,
		a.removeTasks,
		a.removeMilestones,
	} {
		if err := phase(); err != nil {
			return err
		}
	}
	return nil
}

// removeDependencies softens the links the file no longer names. The row is found by
// its two ends, which is what the change key (and the file) identifies it by.
func (a *applier) removeDependencies() error {
	return a.each(func(c Change) error {
		value, ok := c.Before.(depValue)
		if !ok {
			return badValue(c.Key, "a dependency", c.Before)
		}
		pred, ok := a.task(value.Pred)
		if !ok {
			return nil
		}
		succ, ok := a.task(value.Succ)
		if !ok {
			return nil
		}
		var id uuid.UUID
		err := a.tx.QueryRow(a.ctx, `SELECT id FROM project_task_dependency
			WHERE tenant_id = $1 AND project_id = $2 AND task_id = $3 AND depends_on_id = $4
				AND deleted_at IS NULL`, a.tenant, a.pid, succ, pred).Scan(&id)
		if errors.Is(err, orm.ErrNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		return a.softDelete("project_task_dependency", id, c.Key)
	}, kindDependencyDelete)
}

// removeAssignees takes the people off the tasks the file no longer staffs.
func (a *applier) removeAssignees() error {
	return a.each(func(c Change) error {
		value, ok := c.Before.(assignValue)
		if !ok {
			return badValue(c.Key, "an assignment", c.Before)
		}
		task, ok := a.task(value.Task)
		if !ok {
			return nil
		}
		user, known := a.d.users[strings.ToLower(value.Email)]
		if !known {
			return nil
		}
		var id uuid.UUID
		err := a.tx.QueryRow(a.ctx, `SELECT id FROM project_task_user
			WHERE tenant_id = $1 AND project_id = $2 AND task_id = $3 AND user_id = $4
				AND deleted_at IS NULL`, a.tenant, a.pid, task, user).Scan(&id)
		if errors.Is(err, orm.ErrNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		return a.softDelete("project_task_user", id, c.Key)
	}, kindAssignDelete)
}

// removeMilestones deletes the deliverables, taking the links with them: EERP holds a
// deliverable on the task, so a task left producing a row that is gone would load as a
// dependency the file cannot write.
func (a *applier) removeMilestones() error {
	return a.each(func(c Change) error {
		id, ok := a.mileRows[c.Key]
		if !ok {
			return nil
		}
		if _, err := a.tx.Exec(a.ctx, `UPDATE project_task SET milestone_id = NULL, updated_at = now()
			WHERE milestone_id = $1 AND tenant_id = $2`, id, a.tenant); err != nil {
			return err
		}
		return a.softDelete("project_milestone", id, c.Key)
	}, kindMilestoneDelete)
}

// removeTasks deletes the tasks deepest first, so a parent is never left as the live
// parent of a row that was deleted before it.
func (a *applier) removeTasks() error {
	depths := a.depths()
	type doomedTask struct {
		c     Change
		depth int
	}
	var doomed []doomedTask
	for _, c := range a.rows {
		if c.Kind == kindDelete && a.want[c.Key] {
			if id, ok := a.taskRows[c.Key]; ok {
				doomed = append(doomed, doomedTask{c: c, depth: depths[id.String()]})
			}
		}
	}
	slices.SortStableFunc(doomed, func(x, y doomedTask) int { return y.depth - x.depth })
	for _, d := range doomed {
		id := a.taskRows[d.c.Key]
		if err := a.softDelete("project_task", id, d.c.Key); err != nil {
			return err
		}
	}
	return nil
}

// ── One write ────────────────────────────────────────────────────────────────

// check runs the table's rules for one write, on this transaction, and says which row
// of the review list it came from. The body handed in is copied: the rules rewrite it in
// place, and a caller that kept the map would find its own data edited.
func (a *applier) check(table string, o op, id uuid.UUID, body map[string]any, key string) (map[string]any, error) {
	out, err := a.h.check(a.ctx, a.tx, table, o, id, copyOf(body))
	if err != nil {
		return nil, forRow(key, err)
	}
	return out, nil
}

// forRow answers a refused write with the row the manager ticked. The rules name a
// column (parent_id, depends_on_id), which is true of the write and meaningless in a
// list of tasks; what is 422 on the way in has to say which row they have to untick.
// A 403 or 404 keeps its own words: those are not about the selection.
func forRow(key string, err error) error {
	var rej *rejection
	if !errors.As(err, &rej) || rej.status != http.StatusUnprocessableEntity {
		return err
	}
	return &rejection{status: rej.status, code: rej.code, msg: rej.msg, fields: []string{key}}
}

func copyOf(body map[string]any) map[string]any {
	out := make(map[string]any, len(body))
	for k, v := range body {
		out[k] = v
	}
	return out
}

// retype moves a checked body into a model row. The rules speak in the JSON shapes the
// generic handler binds (ids as strings, numbers as float64), the models in Go types,
// and the codec is the one the HTTP write would have used.
func retype(from map[string]any, to any) error {
	raw, err := json.Marshal(from)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, to)
}

// setTask writes the checked columns of one task, and only the ones the rules left.
func (a *applier) setTask(id uuid.UUID, body map[string]any) error {
	if len(body) == 0 {
		return nil
	}
	q := orm.MustRepo[ProjectTask](a.h.db).WithTx(a.tx).UpdateQuery().
		Where(orm.Cond("id = $1 AND tenant_id = $2 AND deleted_at IS NULL", id, a.tenant))
	for k, v := range body {
		q = q.Set(k, v)
	}
	_, err := q.Set("updated_at", time.Now()).Exec(a.ctx, a.tx)
	return err
}

// softDelete is the delete: the column every read already filters on, kept tenant-pinned
// so a batch can never reach another tenant's row.
func (a *applier) softDelete(table string, id uuid.UUID, key string) error {
	if _, err := a.check(table, opDelete, id, nil, key); err != nil {
		return err
	}
	now := time.Now()
	var err error
	switch table {
	case "project_task":
		_, err = orm.MustRepo[ProjectTask](a.h.db).WithTx(a.tx).UpdateQuery().
			Where(orm.Cond("id = $1 AND tenant_id = $2 AND deleted_at IS NULL", id, a.tenant)).
			Set("deleted_at", now).Set("updated_at", now).Exec(a.ctx, a.tx)
	case "project_task_dependency":
		_, err = orm.MustRepo[ProjectTaskDependency](a.h.db).WithTx(a.tx).UpdateQuery().
			Where(orm.Cond("id = $1 AND tenant_id = $2 AND deleted_at IS NULL", id, a.tenant)).
			Set("deleted_at", now).Set("updated_at", now).Exec(a.ctx, a.tx)
	case "project_task_user":
		_, err = orm.MustRepo[ProjectTaskUser](a.h.db).WithTx(a.tx).UpdateQuery().
			Where(orm.Cond("id = $1 AND tenant_id = $2 AND deleted_at IS NULL", id, a.tenant)).
			Set("deleted_at", now).Set("updated_at", now).Exec(a.ctx, a.tx)
	case "project_milestone":
		_, err = orm.MustRepo[ProjectMilestone](a.h.db).WithTx(a.tx).UpdateQuery().
			Where(orm.Cond("id = $1 AND tenant_id = $2 AND deleted_at IS NULL", id, a.tenant)).
			Set("deleted_at", now).Set("updated_at", now).Exec(a.ctx, a.tx)
	default:
		return fmt.Errorf("project: apply does not delete from %s", table)
	}
	if err != nil {
		return err
	}
	a.applied++
	return nil
}

// stage is the column a task moves into when the file says it is (or is not) done: a
// task is closed by where it sits, which is what makes dragging its card and ticking a
// row the same act. A project with no such column refuses the row by its own key: the
// manager has a stage to create first.
func (a *applier) stage(key string, closed bool) (string, error) {
	var id *string
	err := a.tx.QueryRow(a.ctx, `SELECT id::text FROM project_stage
		WHERE project_id = $1 AND tenant_id = $2 AND deleted_at IS NULL AND closed = $3
		ORDER BY sequence, created_at LIMIT 1`, a.pid, a.tenant, closed).Scan(&id)
	if err != nil && !errors.Is(err, orm.ErrNotFound) {
		return "", err
	}
	if id == nil {
		what := "open"
		if closed {
			what = "closed"
		}
		return "", &rejection{status: http.StatusUnprocessableEntity, code: "VALIDATION_ERROR",
			msg: "the project has no " + what + " stage to move the task into", fields: []string{key}}
	}
	return *id, nil
}

// ── Resolving a key ──────────────────────────────────────────────────────────

// task resolves a key the plan or the diff uses for a task: what this batch created, or
// the id the key carries. A key that is neither names nothing apply can write.
func (a *applier) task(key string) (uuid.UUID, bool) {
	if id, ok := a.newTask[key]; ok {
		return id, true
	}
	if id, err := uuid.Parse(key); err == nil {
		return id, true
	}
	return uuid.Nil, false
}

// milestone is task for a deliverable, whose keys carry the milestone: prefix in both
// spaces: EERP's own, and the new-milestone: one the file added rows get from the diff.
func (a *applier) milestone(key string) (uuid.UUID, bool) {
	if id, ok := a.newMile[key]; ok {
		return id, true
	}
	if rest, ok := strings.CutPrefix(key, milestoneRefPrefix); ok {
		if id, err := uuid.Parse(rest); err == nil {
			return id, true
		}
	}
	return uuid.Nil, false
}

func (a *applier) goneMilestone(id uuid.UUID) bool {
	for _, row := range a.rows {
		if row.Kind == kindMilestoneDelete && a.want[row.Key] && a.mileRows[row.Key] == id {
			return true
		}
	}
	return false
}

// depths is how far each task of the current plan sits under the top of its tree, which
// is what the removal order sorts on. Counted once over the plan and read per comparison:
// counting it inside the comparator rebuilt the parent map twice per comparison, some
// 6·10^8 times for a batch at the 5000-task ceiling, inside the transaction that holds
// the project row FOR UPDATE. A key the plan does not hold (a hand built plan's oddity)
// is simply absent, and reads as 0, last among the doomed.
func (a *applier) depths() map[string]int {
	parents := make(map[string]string, len(a.d.cur.Tasks))
	for _, t := range a.d.cur.Tasks {
		parents[t.Key()] = t.Parent
	}
	depth := make(map[string]int, len(parents))
	for key := range parents {
		if _, done := depth[key]; done {
			continue
		}
		// Walk up to the first ancestor whose depth is already known (or to the top),
		// then fill the chain back in from there; seen guards a hand built cycle.
		var chain []string
		seen := map[string]bool{}
		d := 0
		for k := key; ; {
			if v, ok := depth[k]; ok {
				d = v
				break
			}
			parent, ok := parents[k]
			if !ok || parent == "" || seen[k] {
				break
			}
			seen[k] = true
			chain = append(chain, k)
			k = parent
		}
		for n := len(chain) - 1; n >= 0; n-- {
			d++
			depth[chain[n]] = d
		}
	}
	return depth
}

// ── The log line ─────────────────────────────────────────────────────────────

// log is the project's own record of what came in. An import that touches twelve tasks
// is twelve decisions nobody could attribute afterwards without this, and it goes in
// the transaction so a rolled-back import leaves no trace of a thing it did not do.
func (a *applier) log(who auth.Identity, filename string, n int) error {
	var email string
	err := a.tx.QueryRow(a.ctx, `SELECT email FROM users WHERE id = $1 AND tenant_id = $2`,
		who.UserID, a.tenant).Scan(&email)
	if err != nil && !errors.Is(err, orm.ErrNotFound) {
		return err
	}
	_, err = orm.MustRepo[chatter.ChatterMessage](a.h.db).WithTx(a.tx).Create(a.ctx, chatter.ChatterMessage{
		BaseModel:   model.BaseModel{ID: uuid.New(), TenantID: a.tenant},
		TableName:   "project",
		RecordID:    a.pid,
		AuthorID:    who.UserID,
		AuthorEmail: email,
		Kind:        "log",
		Body:        fmt.Sprintf("Imported %s: %d changes", filename, n),
	})
	return err
}
