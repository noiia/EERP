package project

import (
	"context"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"

	"core/orm"

	"github.com/google/uuid"
)

// The diff: the file's plan against the project's, in the file's terms.
//
// It is a pure function of two Plans. It opens no file and runs no query, so the
// same comparison works in a preview over the pool and inside the import's
// transaction, and a test can build both sides in code. That is also why the
// current side is loaded with the FILE's calendar: a duration is a working-day
// count, and two counts only mean the same thing under one mask.
//
// What it returns is a list of rows for the review wizard, each with a key stable
// for the same file and the same project state (spec "Matching and change keys"),
// and the warnings for what the file holds that EERP cannot. A row is a decision,
// never a step of an import: Task 7 ticks keys and re-derives the writes.
//
// Two rules shape everything below.
//
//   - Nothing is matched on anything but the identity the file carries. A name is
//     not an identity: two tasks called "Design" are two tasks, and a file from
//     another project must read as a wholesale import, not as a rename of
//     whatever happens to look similar.
//   - A row of one plan is never shared by two rows of the other, and no row of
//     either plan may disappear without a row of its own. Copy-pasted eerp_ids,
//     duplicate file ids and repeated names are the ways a naive map-by-key diff
//     loses a task in silence.

// Dependents counts what removing a task takes with it, so a removal row can say
// "has 2 timesheets, 1 risk link, 3 subtasks" before anyone ticks it. Live rows
// only: a soft-deleted timesheet is not data a removal loses. Task 8 fills the
// field on the removal rows; diffPlans leaves it nil because it runs no query.
type Dependents struct {
	Subtasks   int `json:"subtasks"`
	Timesheets int `json:"timesheets"`
	RiskLinks  int `json:"risk_links"`
}

// Change is one row of the review list.
type Change struct {
	Key string `json:"key"`
	// Kind is what the row does: create, update, move, delete, dependency,
	// dependency_delete, assign, assign_delete, and the three milestone kinds.
	Kind string `json:"kind"`
	// Task is the label the wizard groups the row under: the name EERP holds for
	// a row it knows, the file's name for a row the file added.
	Task  string `json:"task"`
	Wbs   string `json:"wbs,omitempty"`
	Field string `json:"field,omitempty"`
	// Before and After hold the shapes below (datesValue, moveValue, createValue,
	// depValue, assignValue, milestoneValue) or plain strings, floats and booleans.
	// Both are nil for a removal of a dependency or an assignment, which the key
	// already names.
	Before any `json:"before"`
	After  any `json:"after"`
	// DefaultSelected is false for every removal: nothing that destroys data
	// arrives pre-selected, and "select all" leaves removals alone.
	DefaultSelected bool     `json:"default_selected"`
	Requires        []string `json:"requires,omitempty"`
	// WasUnscheduled marks a dates row on a task EERP has no dates for: the
	// "before" is EERP's placeholder, not a schedule the manager chose.
	WasUnscheduled bool        `json:"was_unscheduled,omitempty"`
	Dependents     *Dependents `json:"dependents,omitempty"`
}

// The kinds, as the wizard's chips and Task 7's dispatch name them.
const (
	kindCreate           = "create"
	kindUpdate           = "update"
	kindMove             = "move"
	kindDelete           = "delete"
	kindDependency       = "dependency"
	kindDependencyDelete = "dependency_delete"
	kindAssign           = "assign"
	kindAssignDelete     = "assign_delete"
	kindMilestoneCreate  = "milestone_create"
	kindMilestoneUpdate  = "milestone_update"
	kindMilestoneDelete  = "milestone_delete"
)

// The fields a row can report, in the words the wizard prints.
const (
	fieldName        = "name"
	fieldDates       = "dates"
	fieldHours       = "planned_hours"
	fieldClosed      = "closed"
	fieldMilestoneID = "milestone_id"
	fieldParent      = "parent"
)

// The warning codes the diff raises. The nine are listed on Warning; HOLIDAYS and
// the two identity codes a decoder needs are raised by the adapters (see gan.go).
const (
	warnUnknownID        = "UNKNOWN_ID"
	warnDuplicateID      = "DUPLICATE_ID"
	warnDepType          = "DEP_TYPE"
	warnDepLag           = "DEP_LAG"
	warnDepFromMilestone = "DEP_FROM_MILESTONE"
	warnMultiMilestone   = "MULTI_MILESTONE"
	warnUnknownEmail     = "UNKNOWN_EMAIL"
	warnNameTruncated    = "NAME_TRUNCATED"
)

// exchangeDayLayout is how the file writes a day, and how the wizard receives one.
const exchangeDayLayout = "2006-01-02"

// nameLimit is the width of the task and milestone name columns.
const nameLimit = 200

// newMilestoneKeyPrefix begins the key of a milestone the file added, the way
// PlanTask.Key() writes it. A milestone EERP holds is keyed by milestoneRefPrefix
// instead; both name a deliverable, neither a dependency.
const newMilestoneKeyPrefix = "new-milestone:"

// datesValue is a dates row: both ends as the file holds them, whole days. The end
// is the duration-th working day, so a Saturday deadline and the duration that
// means are the same pair of days on both sides of the comparison.
type datesValue struct {
	Start string `json:"start"`
	End   string `json:"end"`
}

// moveValue is a move row: "under X, after Y", either of them null for the top
// level and for the first sibling.
type moveValue struct {
	Parent *string `json:"parent"`
	After  *string `json:"after"`
}

// createValue is what a row the file added would hold. The parent and the
// deliverable are carried by key, never by name: names repeat, and apply must
// never have to guess which "Design" the row meant.
type createValue struct {
	Name         string          `json:"name"`
	Parent       *string         `json:"parent"`
	Start        string          `json:"start"`
	End          string          `json:"end"`
	PlannedHours float64         `json:"planned_hours"`
	MilestoneID  *milestoneValue `json:"milestone_id,omitempty"`
}

// milestoneValue names the deliverable a task produces. ID is the milestone's key
// in the plan: milestone:<uuid>, or new-milestone:<file id> when the file added it
// and the create is in Requires.
type milestoneValue struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// depValue names both ends of a dependency: the keys for apply, the names for the
// label. The keys are also inside the row's own key, but a key is a string built
// by concatenation, and ends whose own key holds a colon cannot be read back out
// of it. Apply reads these.
type depValue struct {
	Pred     string `json:"pred"`
	PredName string `json:"pred_name,omitempty"`
	Succ     string `json:"succ"`
	SuccName string `json:"succ_name,omitempty"`
}

// assignValue names the person by the lowercased email the staff map is keyed on,
// so the same account written two ways in one file is one row and one lookup.
type assignValue struct {
	Task  string `json:"task"`
	Email string `json:"email"`
	Name  string `json:"name"`
}

// diffPlans compares the current plan with the file's.
//
// cur must have been loaded with the file's own weekend (see loadPlan), which is
// the only calendar under which the two sides' durations mean the same thing.
// users maps lower(email) to a live staff user of the tenant: an address outside
// it cannot be assigned, and the manager is told which one (UNKNOWN_EMAIL).
//
// Rows come back in the order the wizard shows them: the file's task order, with
// a removal beside the neighbour it used to sit next to, and within a task its
// create, move, updates, dependencies, assignees, then removals.
func diffPlans(cur, file Plan, users map[string]uuid.UUID) ([]Change, []Warning) {
	d := &diff{cur: cur, file: file, users: users}
	d.match()
	d.readDepSets()
	d.taskRows()
	d.moveRows()
	d.depRows()
	d.assignRows()
	return d.finish()
}

// ── The comparison's state ───────────────────────────────────────────────────

type diff struct {
	cur, file Plan
	users     map[string]uuid.UUID

	warnings []Warning
	rows     []diffRow

	// curByKey is the FIRST current row carrying each identity. A second one (only
	// a hand-built plan can hold two) is left unmatched, so it is offered for
	// removal rather than silently shared with the first.
	curByKey map[string]int
	// consumed[c] is the current row already taken by a file row. Two file rows
	// may never land on one current row: they would overwrite each other on apply,
	// and one of them would vanish.
	consumed []bool
	// curToFile[c] is the file position of the file row that took current row c.
	// It is only meaningful where consumed[c] is true. Anchors are file positions,
	// so a row placed beside a current neighbour must be translated through this
	// rather than handed the neighbour's current index: the two spaces only agree
	// while the file keeps the project's order above that row.
	curToFile []int

	fileRows     []fileRow
	fileRowByKey map[string]int // as the file writes a key, to the row carrying it
	fileIdxByKey map[string]int // by the diff's identity, to the file row

	depsCur  depSet
	depsFile depSet

	wbs map[int]string // current row index to its dotted WBS position
}

// fileRow is a file row's standing after matching.
type fileRow struct {
	// key is the row's identity inside the exchange: the EERP identity it matched,
	// or its own new: key. Never the Ref a foreign file happened to carry: two rows
	// copy-pasting one eerp_id would otherwise share a key, and one of them would
	// disappear from the list without a word.
	key     string
	matched bool
	cur     int
}

// diffRow is a row under construction, with the two numbers that place it in the
// wizard's reading order.
type diffRow struct {
	c Change
	// anchor is the file position of the row the change is about. A change about a
	// row the file no longer holds anchors on the file position of the current
	// neighbour it used to sit after, or -1 to sit at the top of the list.
	anchor int
	phase  int
}

// The phases inside one task's group, in the order the wizard reads them.
const (
	phaseCreate = iota
	phaseMove
	phaseUpdate
	phaseDep
	phaseAssign
	phaseDelete
)

// depSet is one plan's dependencies in the two forms EERP can hold: finish-to-start
// links between two tasks, and each task's single deliverable. The slices keep the
// order the plan listed them in, so the rows are built deterministically.
type depSet struct {
	deps      map[depKey]bool
	order     []depKey
	links     map[string]string
	linkOrder []string
}

type depKey struct{ pred, succ string }

// ── Matching ─────────────────────────────────────────────────────────────────

func (d *diff) match() {
	d.curByKey = make(map[string]int, len(d.cur.Tasks))
	for i, t := range d.cur.Tasks {
		if _, dup := d.curByKey[t.Key()]; !dup {
			d.curByKey[t.Key()] = i
		}
	}
	d.consumed = make([]bool, len(d.cur.Tasks))
	d.curToFile = make([]int, len(d.cur.Tasks))
	d.fileRows = make([]fileRow, len(d.file.Tasks))
	d.fileRowByKey = make(map[string]int, len(d.file.Tasks))
	d.fileIdxByKey = make(map[string]int, len(d.file.Tasks))
	d.wbs = wbsNumbers(d.cur.Tasks)

	taken := map[string]bool{}
	for i := range d.file.Tasks {
		row := d.accept(i, taken)
		d.fileRows[i] = row
		if row.matched {
			d.curToFile[row.cur] = i
		}
		if _, dup := d.fileRowByKey[d.file.Tasks[i].Key()]; !dup {
			d.fileRowByKey[d.file.Tasks[i].Key()] = i
		}
		if _, dup := d.fileIdxByKey[row.key]; !dup {
			d.fileIdxByKey[row.key] = i
		}
	}
}

// accept matches one file row against the current plan, and gives it its identity.
func (d *diff) accept(i int, taken map[string]bool) fileRow {
	t := d.file.Tasks[i]
	ref := t.Ref
	if ref != "" && !validRef(ref) {
		// Not an EERP identity at all. The decoder drops such a value the same way
		// (see ganWalker.eerpRef); here it also keeps the file out of the new:
		// namespace, whose keys Key() builds from the file id.
		d.warn(warnUnknownID, t.Name, "the file's eerp_id is not an EERP id; the task is imported as a new task")
		ref = ""
	}
	if ref != "" && namesMilestone(ref) == t.Milestone {
		if c, ok := d.curByKey[ref]; ok {
			if !d.consumed[c] {
				d.consumed[c] = true
				return fileRow{key: fileKey(t, true), cur: c, matched: true}
			}
			d.warn(warnDuplicateID, t.Name, "two rows of the file carry the same eerp_id; only the first is matched to the task")
			return fileRow{key: d.uniqueNewKey(t, taken), cur: -1}
		}
	}
	if ref != "" {
		// An identity that names nothing here. It includes an eerp_id whose
		// milestone-ness contradicts the row carrying it: no current row can be
		// that row, and matching a task to a milestone of the same uuid because the
		// file wrote both would be the diff inventing a link between two rows it
		// cannot tell apart. The row is new, and what it contradicted is offered
		// for removal: two decisions the manager can see.
		d.warn(warnUnknownID, t.Name, "the file's eerp_id names nothing in this project; the task is imported as a new task")
	}
	return fileRow{key: d.uniqueNewKey(t, taken), cur: -1}
}

// fileKey is a file row's identity inside the exchange: the EERP identity when the
// row matched a task of this project, and its own new: key otherwise.
//
// Task 7's apply resolves new:<file id> keys and must use this rule rather than
// fall back to PlanTask.Key(): a row carrying an eerp_id this project does not
// know IS a new task, and Key() would name it by the id it copied.
func fileKey(t PlanTask, matched bool) string {
	if matched {
		return t.Ref
	}
	if t.Milestone {
		return newMilestoneKeyPrefix + t.FileID
	}
	return "new:" + t.FileID
}

// uniqueNewKey gives a new row its key, and keeps it unique: two rows the file
// added that call themselves the same (only a hand-written .gan can; a decoded one
// numbers its rows 1..n) would otherwise share a key and lose one of them.
func (d *diff) uniqueNewKey(t PlanTask, taken map[string]bool) string {
	key := fileKey(t, false)
	if taken[key] {
		key = key + "#" + strconv.Itoa(len(taken)+1)
		d.warn(warnDuplicateID, t.Name, "two rows of the file share a file id; each is imported on its own")
	}
	taken[key] = true
	return key
}

// namesMilestone reports whether a key is a milestone's. Both spaces count: a
// milestone EERP holds is "milestone:<uuid>", one the file added is
// "new-milestone:<file id>", and a link to either is the task's deliverable rather
// than a dependency.
func namesMilestone(key string) bool {
	return strings.HasPrefix(key, milestoneRefPrefix) ||
		strings.HasPrefix(key, newMilestoneKeyPrefix)
}

// identity translates a key as one plan writes it (PlanTask.Key()) into the diff's
// identity for the row carrying it. Parents, dependency ends and assignments come
// from the file in the first space.
func (d *diff) identity(key string) (string, bool) {
	if i, ok := d.fileRowByKey[key]; ok {
		return d.fileRows[i].key, true
	}
	return "", false
}

// ── The current tree's WBS labels ────────────────────────────────────────────

// wbsNumbers gives each current row the dotted position the wizard groups rows by.
// It is the database's own wbs_number: the triggers keep sequence dense from 1
// within each parent and wbs_number the dotted path of those positions (see
// migrate.go), and the loader has already put the rows in that order, so counting
// siblings as they come reproduces it. A milestone has no position (spec: they are
// exported at the top level, after the tasks), so it gets no label.
func wbsNumbers(tasks []PlanTask) map[int]string {
	out := make(map[int]string, len(tasks))
	counts := map[string]int{}
	paths := map[string]string{}
	for i, t := range tasks {
		if t.Milestone {
			continue
		}
		counts[t.Parent]++
		path := strconv.Itoa(counts[t.Parent])
		if p, ok := paths[t.Parent]; ok && p != "" {
			path = p + "." + path
		}
		out[i] = path
		if _, dup := paths[t.Key()]; !dup {
			paths[t.Key()] = path
		}
	}
	return out
}

// ── Field rows, creates and removals ─────────────────────────────────────────

func (d *diff) taskRows() {
	for i := range d.file.Tasks {
		if d.fileRows[i].matched {
			d.updateRows(i, d.fileRows[i].cur)
			continue
		}
		d.createRow(i)
	}
	for c := range d.cur.Tasks {
		if !d.consumed[c] {
			d.deleteRow(c)
		}
	}
}

// updateRows compares one matched pair field by field. A milestone holds neither
// hours nor a completion in EERP, so its rows are its name and its deadline: what
// the file invents for the rest is not a change to anything.
func (d *diff) updateRows(i, c int) {
	d.nameRow(i, c)
	d.datesRow(i, c)
	if d.file.Tasks[i].Milestone {
		return
	}
	d.hoursRow(i, c)
	d.closedRow(i, c)
}

func (d *diff) nameRow(i, c int) {
	want, truncated := clipName(d.file.Tasks[i].Name)
	if truncated {
		d.warn(warnNameTruncated, d.file.Tasks[i].Name,
			fmt.Sprintf("a name longer than %d characters does not fit; it is truncated", nameLimit))
	}
	if want == d.cur.Tasks[c].Name {
		return
	}
	d.add(i, phaseUpdate, Change{
		Key:             changeKey(d.fileRows[i].key, fieldName),
		Kind:            d.updateKind(c),
		Task:            d.cur.Tasks[c].Name,
		Wbs:             d.wbs[c],
		Field:           fieldName,
		Before:          d.cur.Tasks[c].Name,
		After:           want,
		DefaultSelected: true,
	})
}

// datesRow reports a schedule change, as the two ends the file holds. A summary's
// dates are what its children add up to, which GanttProject computes and EERP does
// not, so the file's figure for one is dropped without a word (spec "Values
// GanttProject recalculates").
func (d *diff) datesRow(i, c int) {
	ft, ct := d.file.Tasks[i], d.cur.Tasks[c]
	if !ft.Milestone && ft.HasChildren {
		return
	}
	if ft.Start.Equal(ct.Start) && ft.Duration == ct.Duration {
		return
	}
	d.add(i, phaseUpdate, Change{
		Key:             changeKey(d.fileRows[i].key, fieldDates),
		Kind:            d.updateKind(c),
		Task:            ct.Name,
		Wbs:             d.wbs[c],
		Field:           fieldDates,
		Before:          datesOf(ct, d.cur.Weekend),
		After:           datesOf(ft, d.file.Weekend),
		DefaultSelected: true,
		WasUnscheduled:  ct.Undated,
	})
}

func (d *diff) hoursRow(i, c int) {
	ft, ct := d.file.Tasks[i], d.cur.Tasks[c]
	if samePlannedHours(ct.PlannedHours, ft.PlannedHours) {
		return
	}
	d.add(i, phaseUpdate, Change{
		Key:             changeKey(d.fileRows[i].key, fieldHours),
		Kind:            d.updateKind(c),
		Task:            ct.Name,
		Wbs:             d.wbs[c],
		Field:           fieldHours,
		Before:          ct.PlannedHours,
		After:           ft.PlannedHours,
		DefaultSelected: true,
	})
}

// closedRow reports a closing or a reopening, and nothing else: completion means
// closed and nothing else, so a file saying 40 is not a percentage EERP holds.
func (d *diff) closedRow(i, c int) {
	ft, ct := d.file.Tasks[i], d.cur.Tasks[c]
	if ft.HasChildren {
		return
	}
	was, now := ct.Complete == 100, ft.Complete == 100
	if was == now {
		return
	}
	d.add(i, phaseUpdate, Change{
		Key:             changeKey(d.fileRows[i].key, fieldClosed),
		Kind:            d.updateKind(c),
		Task:            ct.Name,
		Wbs:             d.wbs[c],
		Field:           fieldClosed,
		Before:          was,
		After:           now,
		DefaultSelected: true,
	})
}

func (d *diff) createRow(i int) {
	ft := d.file.Tasks[i]
	kind := kindCreate
	if ft.Milestone {
		kind = kindMilestoneCreate
	}
	value := createValue{
		Name:         ft.Name,
		Parent:       strPtr(d.fileParent(i)),
		Start:        day(ft.Start).Format(exchangeDayLayout),
		End:          endAfter(ft.Start, ft.Duration, d.file.Weekend).Format(exchangeDayLayout),
		PlannedHours: ft.PlannedHours,
	}
	var requires []string
	if parent := d.fileParent(i); d.needsCreate(parent) {
		requires = append(requires, parent)
	}
	// A row the file added has no task to point at, so its deliverable rides inside
	// its create rather than as a row of its own.
	if gate, ok := d.depsFile.links[d.fileRows[i].key]; ok {
		value.MilestoneID = &milestoneValue{ID: gate, Name: d.nameOf(gate)}
		if d.needsCreate(gate) {
			requires = append(requires, gate)
		}
	}
	d.add(i, phaseCreate, Change{
		Key:             d.fileRows[i].key,
		Kind:            kind,
		Task:            ft.Name,
		Before:          nil,
		After:           value,
		DefaultSelected: true,
		Requires:        requires,
	})
}

func (d *diff) deleteRow(c int) {
	ct := d.cur.Tasks[c]
	key := ct.Key()
	kind := kindDelete
	if ct.Milestone {
		kind = kindMilestoneDelete
	}
	// The file lost the whole subtree, so the parent's removal is not a decision on
	// its own: it names the children it needs ticked with it (spec "Selection
	// consistency": a summary deleted while its children stay is a 422).
	var requires []string
	for j := range d.cur.Tasks {
		if d.consumed[j] || d.cur.Tasks[j].Parent != key {
			continue
		}
		requires = append(requires, changeKey(d.cur.Tasks[j].Key(), "delete"))
	}
	d.add(d.deleteAnchor(c), phaseDelete, Change{
		Key:             changeKey(key, "delete"),
		Kind:            kind,
		Task:            ct.Name,
		Wbs:             d.wbs[c],
		Before:          nil,
		After:           nil,
		DefaultSelected: false,
		Requires:        requires,
	})
}

// deleteAnchor is where a removal sits: beside the current neighbour the file still
// holds, which is where the task used to be, or at the top of the list.
//
// The neighbour is found in the current order and handed back as a *file* position,
// because anchors are file positions (see finish): the two spaces only agree while
// the file keeps the project's order above the lost row, and a create or a move
// inserted above it is exactly when they do not. With cur [A, B, X] and the file
// [new, A, B], X's removal sits after B's group, the neighbour it used to follow,
// not inside A's.
func (d *diff) deleteAnchor(c int) int {
	for j := c - 1; j >= 0; j-- {
		if d.consumed[j] {
			return d.curToFile[j]
		}
	}
	return -1
}

func (d *diff) updateKind(c int) string {
	if d.cur.Tasks[c].Milestone {
		return kindMilestoneUpdate
	}
	return kindUpdate
}

// clipName truncates a name to what the column holds, reporting whether it had to.
// Runes, not bytes: a manager's names are not ASCII.
func clipName(name string) (string, bool) {
	runes := []rune(name)
	if len(runes) <= nameLimit {
		return name, false
	}
	return string(runes[:nameLimit]), true
}

func datesOf(t PlanTask, w Weekend) datesValue {
	return datesValue{
		Start: day(t.Start).Format(exchangeDayLayout),
		End:   endAfter(t.Start, t.Duration, w).Format(exchangeDayLayout),
	}
}

// samePlannedHours compares hours the way the file writes them, at a cent: a
// planner storing 8 as 8.000001 says nothing. A NaN, which a double precision
// column can hold, is taken to equal itself, so one corrupt row does not invent a
// change on every preview of the project.
func samePlannedHours(a, b float64) bool {
	if math.IsNaN(a) || math.IsNaN(b) {
		return math.IsNaN(a) == math.IsNaN(b)
	}
	return math.Round(a*100) == math.Round(b*100)
}

// ── Moves ────────────────────────────────────────────────────────────────────

// moveRows reports the minimal set of siblings that have to move. For each parent,
// the children the two plans agree on are kept in the order they already have, and
// only the rest get a row: inserting a task near the top of a long list therefore
// says nothing about the tasks below it (spec "Moves").
//
// Milestones take no part. EERP gives them no parent and no position among the
// tasks, both plans hold them last, and a row for one would be a decision apply
// cannot carry out.
func (d *diff) moveRows() {
	type siblings struct {
		cur  []int
		file []int
	}
	byParent := map[string]*siblings{}
	var parents []string
	note := func(p string) *siblings {
		s := byParent[p]
		if s == nil {
			s = &siblings{}
			byParent[p] = s
			parents = append(parents, p)
		}
		return s
	}

	for i := range d.file.Tasks {
		if !d.fileRows[i].matched || d.file.Tasks[i].Milestone {
			continue
		}
		s := note(d.fileParent(i))
		s.file = append(s.file, i)
	}
	for c := range d.cur.Tasks {
		if !d.consumed[c] || d.cur.Tasks[c].Milestone {
			continue
		}
		s := note(d.cur.Tasks[c].Parent)
		s.cur = append(s.cur, c)
	}
	for _, p := range parents {
		s := byParent[p]
		for _, i := range d.outsideLcs(s.cur, s.file) {
			d.moveRow(i)
		}
	}
}

// moveRow says "under X, after Y" in the file's terms. The absolute position is
// computed at apply time from the rows actually ticked.
func (d *diff) moveRow(i int) {
	c := d.fileRows[i].cur
	ct := d.cur.Tasks[c]
	parent := d.fileParent(i)
	after := d.precedingFile(i, parent)

	var requires []string
	if d.needsCreate(parent) {
		requires = append(requires, parent)
	}
	if after != nil && *after != parent && d.needsCreate(*after) {
		requires = append(requires, *after)
	}

	d.add(i, phaseMove, Change{
		Key:             changeKey(d.fileRows[i].key, "move"),
		Kind:            kindMove,
		Task:            ct.Name,
		Wbs:             d.wbs[c],
		Field:           fieldParent,
		Before:          moveValue{Parent: strPtr(ct.Parent), After: d.precedingCur(c, ct.Parent)},
		After:           moveValue{Parent: strPtr(parent), After: after},
		DefaultSelected: true,
		Requires:        requires,
	})
}

// outsideLcs is the set of siblings that have to move: the children of one parent
// that are not part of the longest run the two orders agree on. Each task appears
// at most once in either list, so the longest common subsequence is the longest
// increasing run of current positions along the file's order: patience sorting,
// O(n log n), rather than the O(n·m) table a 5000-row parent would cost.
func (d *diff) outsideLcs(curIdx, fileIdx []int) []int {
	pos := make(map[string]int, len(curIdx))
	for n, c := range curIdx {
		pos[d.cur.Tasks[c].Key()] = n
	}
	var kept []int
	var positions []int
	for _, i := range fileIdx {
		// A sibling EERP has elsewhere is not in the run: it is missing from pos,
		// gets no place in it, and so is reported as a move. That is how a parent
		// change becomes a move without a rule of its own.
		if n, ok := pos[d.fileRows[i].key]; ok {
			kept = append(kept, i)
			positions = append(positions, n)
		}
	}
	in := map[int]bool{}
	for _, i := range longestIncreasing(positions) {
		in[kept[i]] = true
	}
	var out []int
	for _, i := range fileIdx {
		if !in[i] {
			out = append(out, i)
		}
	}
	return out
}

// longestIncreasing returns the indices of a longest strictly increasing
// subsequence of seq, by patience sorting with the predecessors remembered.
func longestIncreasing(seq []int) []int {
	if len(seq) == 0 {
		return nil
	}
	var tails []int
	prev := make([]int, len(seq))
	for i := range prev {
		prev[i] = -1
	}
	for i, v := range seq {
		lo, hi := 0, len(tails)
		for lo < hi {
			mid := (lo + hi) / 2
			if seq[tails[mid]] < v {
				lo = mid + 1
			} else {
				hi = mid
			}
		}
		if lo > 0 {
			prev[i] = tails[lo-1]
		}
		if lo == len(tails) {
			tails = append(tails, i)
		} else {
			tails[lo] = i
		}
	}
	out := make([]int, len(tails))
	for n, i := len(tails)-1, tails[len(tails)-1]; n >= 0; n-- {
		out[n] = i
		i = prev[i]
	}
	return out
}

// precedingFile is the sibling the file puts right before a row, new rows included:
// "after Y" names whoever the file says is above it, and a Y the file added is in
// Requires.
func (d *diff) precedingFile(i int, parent string) *string {
	for j := i - 1; j >= 0; j-- {
		if d.file.Tasks[j].Milestone {
			continue
		}
		if d.fileParent(j) == parent {
			key := d.fileRows[j].key
			return &key
		}
	}
	return nil
}

func (d *diff) precedingCur(c int, parent string) *string {
	for j := c - 1; j >= 0; j-- {
		if d.cur.Tasks[j].Milestone {
			continue
		}
		if d.cur.Tasks[j].Parent == parent {
			key := d.cur.Tasks[j].Key()
			return &key
		}
	}
	return nil
}

// fileParent is the parent a file row hangs under, in the diff's identities. A
// milestone is flattened (spec: a milestone nested under a task is read at the top
// level, with no warning), and a parent the file does not have is no parent.
func (d *diff) fileParent(i int) string {
	t := d.file.Tasks[i]
	if t.Milestone || t.Parent == "" {
		return ""
	}
	if key, ok := d.identity(t.Parent); ok {
		return key
	}
	return ""
}

// ── Dependencies ─────────────────────────────────────────────────────────────

// readDepSets turns both plans' dependencies into what EERP can hold. Only the
// file's side is reported on: a value the loader cannot produce on the current side
// is a hand-built plan's oddity, and reporting it as a removal would blame the
// manager for data EERP does not have.
func (d *diff) readDepSets() {
	d.depsCur = d.readDepSet(d.cur.Deps, false)
	d.depsFile = d.readDepSet(d.file.Deps, true)
}

func (d *diff) readDepSet(deps []PlanDep, fromFile bool) depSet {
	set := depSet{deps: map[depKey]bool{}, links: map[string]string{}}
	for _, dep := range deps {
		pred, succ, ok := d.knownEnds(dep.Pred, dep.Succ, fromFile)
		if !ok {
			continue
		}
		if namesMilestone(pred) {
			d.fileWarn(fromFile, warnDepFromMilestone, d.fileLabel(succ),
				"a dependency from a milestone is not a link EERP has; it is not imported")
			continue
		}
		if dep.Type != DepFS {
			d.fileWarn(fromFile, warnDepType, d.fileLabel(pred),
				"EERP knows finish-to-start dependencies only; this one is not imported")
			continue
		}
		if dep.Lag != 0 {
			d.fileWarn(fromFile, warnDepLag, d.fileLabel(pred),
				"a lag has no place in EERP's schedule; the dependency is imported without it")
		}
		if namesMilestone(succ) {
			d.noteLink(&set, pred, succ, fromFile)
			continue
		}
		key := depKey{pred: pred, succ: succ}
		if !set.deps[key] {
			set.deps[key] = true
			set.order = append(set.order, key)
		}
	}
	return set
}

// noteLink records a task's deliverable. A task produces one, so the first
// milestone successor is kept and the rest are reported.
func (d *diff) noteLink(set *depSet, pred, succ string, fromFile bool) {
	if old, seen := set.links[pred]; seen {
		if old == succ {
			return
		}
		d.fileWarn(fromFile, warnMultiMilestone, d.fileLabel(pred),
			"a task produces one deliverable; the first milestone is kept and the rest dropped")
		return
	}
	set.links[pred] = succ
	set.linkOrder = append(set.linkOrder, pred)
}

// knownEnds translates a dependency's ends into the diff's identities and drops a
// link whose end the plan does not hold: a row that is not there is not a change,
// and the decoders drop such links already.
func (d *diff) knownEnds(pred, succ string, fromFile bool) (string, string, bool) {
	if !fromFile {
		if _, ok := d.curByKey[pred]; !ok {
			return "", "", false
		}
		if _, ok := d.curByKey[succ]; !ok {
			return "", "", false
		}
		return pred, succ, true
	}
	p, ok := d.identity(pred)
	if !ok {
		return "", "", false
	}
	s, ok := d.identity(succ)
	if !ok {
		return "", "", false
	}
	return p, s, true
}

func (d *diff) depRows() {
	d.dependencyRows()
	d.linkRows()
}

// dependencyRows reports the links EERP does not have and the ones it has and the
// file no longer names.
//
// A removal of a dependency is a row of its own even when one of its ends is being
// deleted too. Nothing subsumes it: the two rows are two decisions, and the manager
// who unticks the task's removal to keep it must still be given the removed link to
// tick, or the file's divergence from the project is inexpressible. What the spec's
// "Selection consistency" section does require is that a row on a *new* task has its
// create ticked, and that a summary is not deleted while its subtasks stay; neither
// is a licence to drop a row. A removal is unticked, so the cost of always showing
// one is a row nobody selected.
func (d *diff) dependencyRows() {
	for _, k := range d.depsFile.order {
		if d.depsCur.deps[k] {
			continue
		}
		d.add(d.anchorOf(k.pred), phaseDep, Change{
			Key:             "dep:" + k.pred + ":" + k.succ,
			Kind:            kindDependency,
			Task:            d.nameOf(k.pred),
			Wbs:             d.wbsOf(k.pred),
			After:           d.depValueOf(k),
			DefaultSelected: true,
			Requires:        d.endRequires(k),
		})
	}
	for _, k := range d.depsCur.order {
		if d.depsFile.deps[k] {
			continue
		}
		d.add(d.anchorOf(k.pred), phaseDelete, Change{
			Key:             "dep:" + k.pred + ":" + k.succ + ":delete",
			Kind:            kindDependencyDelete,
			Task:            d.nameOf(k.pred),
			Wbs:             d.wbsOf(k.pred),
			Before:          d.depValueOf(k),
			DefaultSelected: false,
		})
	}
}

// linkRows reports a task's deliverable changing, including being cleared.
//
// Only a row the file added carries its deliverable inside its create instead,
// because there is no task yet to update. A task the file lost gets its clearing row
// like any other: the removal of the task is a separate decision, and unticking it
// has to leave a row to tick for the link (see dependencyRows).
func (d *diff) linkRows() {
	done := map[string]bool{}
	for _, pred := range d.depsFile.linkOrder {
		done[pred] = true
		d.linkRow(pred)
	}
	for _, pred := range d.depsCur.linkOrder {
		if !done[pred] {
			d.linkRow(pred)
		}
	}
}

func (d *diff) linkRow(pred string) {
	want, have := d.depsFile.links[pred], d.depsCur.links[pred]
	if want == have {
		return
	}
	// The row must be about a task EERP holds. One the file added has its create
	// instead (see createRow); one the file lost is still a task of the project, and
	// its cleared deliverable is a decision of its own.
	if i, ok := d.fileIdxByKey[pred]; ok && !d.fileRows[i].matched {
		return
	}
	c, ok := d.curByKey[pred]
	if !ok {
		return
	}
	var requires []string
	if d.needsCreate(want) {
		requires = append(requires, want)
	}
	d.add(d.anchorOf(pred), phaseDep, Change{
		Key:             changeKey(pred, fieldMilestoneID),
		Kind:            kindUpdate,
		Task:            d.cur.Tasks[c].Name,
		Wbs:             d.wbs[c],
		Field:           fieldMilestoneID,
		Before:          milestoneValueOf(have, d.nameOf),
		After:           milestoneValueOf(want, d.nameOf),
		DefaultSelected: want != "",
		Requires:        requires,
	})
}

func (d *diff) depValueOf(k depKey) depValue {
	return depValue{Pred: k.pred, PredName: d.nameOf(k.pred), Succ: k.succ, SuccName: d.nameOf(k.succ)}
}

// endRequires names the ends the file added: a dependency cannot be created before
// the tasks it links exist.
func (d *diff) endRequires(k depKey) []string {
	var out []string
	for _, key := range []string{k.pred, k.succ} {
		if d.needsCreate(key) {
			out = append(out, key)
		}
	}
	return out
}

func milestoneValueOf(key string, label func(string) string) *milestoneValue {
	if key == "" {
		return nil
	}
	return &milestoneValue{ID: key, Name: label(key)}
}

// ── Assignments ──────────────────────────────────────────────────────────────

// assignRows compares who works on what, by the lowercased email. An allocation to
// a row the file does not have, or to a milestone, is nothing to do: EERP assigns
// people to tasks.
func (d *diff) assignRows() {
	cur := assignIndex(d.cur.Assignments, func(key string) (string, bool) { return key, true })
	file := assignIndex(d.file.Assignments, d.identity)
	d.assignAdded(cur)
	d.assignRemoved(file)
}

// assignAdded reports a person the file gives to a task EERP does not hold them on
// yet. A name nobody owns is reported and dropped: guessing a colleague from a
// typo would put the wrong person on the schedule.
func (d *diff) assignAdded(cur map[string]map[string]PlanAssign) {
	done := map[string]bool{}
	for _, a := range d.file.Assignments {
		key, ok := d.identity(a.Task)
		email := strings.ToLower(strings.TrimSpace(a.Email))
		if !ok || email == "" || namesMilestone(key) {
			continue
		}
		if _, had := cur[key][email]; had || done[key+"|"+email] {
			continue
		}
		done[key+"|"+email] = true
		if _, known := d.users[email]; !known {
			d.warn(warnUnknownEmail, d.fileLabel(key),
				fmt.Sprintf("no staff account has the email %s; the assignment is not imported", a.Email))
			continue
		}
		var requires []string
		if d.needsCreate(key) {
			requires = append(requires, key)
		}
		d.add(d.anchorOf(key), phaseAssign, Change{
			Key:             "assign:" + key + ":" + email,
			Kind:            kindAssign,
			Task:            d.nameOf(key),
			Wbs:             d.wbsOf(key),
			After:           assignValue{Task: key, Email: email, Name: a.Name},
			DefaultSelected: true,
			Requires:        requires,
		})
	}
}

// assignRemoved reports a person EERP holds that the file no longer names. Taking a
// colleague off a task loses their work on it, so the row arrives unticked.
//
// Like a removed dependency, the row is never subsumed by the removal of its task
// (see dependencyRows): keep the task, and the assignment still has to be ticked off
// somewhere. The row is about a task of the current plan, which is what keeps a key
// the plan does not hold (a hand built plan's oddity, a milestone) out of the list:
// EERP assigns people to tasks.
func (d *diff) assignRemoved(file map[string]map[string]PlanAssign) {
	for _, a := range d.cur.Assignments {
		key, email := a.Task, strings.ToLower(strings.TrimSpace(a.Email))
		if _, held := d.curByKey[key]; !held || namesMilestone(key) {
			continue
		}
		if _, had := file[key][email]; had {
			continue
		}
		d.add(d.anchorOf(key), phaseDelete, Change{
			Key:             "assign:" + key + ":" + email + ":delete",
			Kind:            kindAssignDelete,
			Task:            d.nameOf(key),
			Wbs:             d.wbsOf(key),
			Before:          assignValue{Task: key, Email: email, Name: a.Name},
			DefaultSelected: false,
		})
	}
}

// assignIndex groups assignments by task key and lowercased email, translating the
// keys through translate so both plans' rows land in the same namespace.
func assignIndex(assigns []PlanAssign, translate func(string) (string, bool)) map[string]map[string]PlanAssign {
	out := map[string]map[string]PlanAssign{}
	for _, a := range assigns {
		key, ok := translate(a.Task)
		email := strings.ToLower(strings.TrimSpace(a.Email))
		if !ok || key == "" || email == "" {
			continue
		}
		if out[key] == nil {
			out[key] = map[string]PlanAssign{}
		}
		if _, dup := out[key][email]; !dup {
			out[key][email] = a
		}
	}
	return out
}

// ── Where a row sits, and what it is about ───────────────────────────────────

// anchorOf is the file position a row about one key belongs at. A row about a row
// the file holds sits inside that row's group. A row about a row the file lost (the
// dependency, assignment or deliverable of a task that is itself being removed) has
// no group of its own to sit in, and goes to the top of the list with the other
// removals rather than at some current index the wizard cannot read; a removal of a
// task places itself beside its former neighbour with deleteAnchor, where it is built.
func (d *diff) anchorOf(key string) int {
	if i, ok := d.fileIdxByKey[key]; ok {
		return i
	}
	return -1
}

// needsCreate reports whether a key names a row the file added, and so has to be
// created before anything that points at it.
func (d *diff) needsCreate(key string) bool {
	if key == "" {
		return false
	}
	if i, ok := d.fileIdxByKey[key]; ok {
		return !d.fileRows[i].matched
	}
	return false
}

// nameOf labels a key: the name EERP holds for it, or the file's for a row EERP
// does not know yet.
func (d *diff) nameOf(key string) string {
	if c, ok := d.curByKey[key]; ok {
		return d.cur.Tasks[c].Name
	}
	if i, ok := d.fileIdxByKey[key]; ok {
		return d.file.Tasks[i].Name
	}
	return key
}

// fileLabel labels a key the way the file does, for a warning about the file.
func (d *diff) fileLabel(key string) string {
	if i, ok := d.fileIdxByKey[key]; ok {
		return d.file.Tasks[i].Name
	}
	return d.nameOf(key)
}

// wbsOf is the WBS label of a row EERP holds, and empty for one the file added.
func (d *diff) wbsOf(key string) string {
	if i, ok := d.fileIdxByKey[key]; ok && d.fileRows[i].matched {
		return d.wbs[d.fileRows[i].cur]
	}
	return ""
}

// changeKey builds a row's key: task:<uuid>:<field> for a task,
// milestone:<uuid>:<field> for a milestone (whose identity already carries the
// prefix). A new row's key is its own new:<file id>, whole.
func changeKey(key, field string) string {
	if namesMilestone(key) {
		return key + ":" + field
	}
	return "task:" + key + ":" + field
}

func (d *diff) add(anchor, phase int, c Change) {
	d.rows = append(d.rows, diffRow{c: c, anchor: anchor, phase: phase})
}

func (d *diff) warn(code, task, message string) {
	d.warnings = append(d.warnings, Warning{Code: code, Message: message, Task: task})
}

// fileWarn reports something the file holds that EERP cannot.
func (d *diff) fileWarn(fromFile bool, code, task, message string) {
	if fromFile {
		d.warn(code, task, message)
	}
}

// finish puts the rows in the order the wizard reads them: by the file position
// they belong to, then create, move, updates, dependencies, assignees, removals.
// The sort is stable, so rows of one task keep the order they were built in, which
// is the order the fields are compared in.
func (d *diff) finish() ([]Change, []Warning) {
	if len(d.rows) == 0 {
		return nil, d.warnings
	}
	sort.SliceStable(d.rows, func(i, j int) bool {
		a, b := d.rows[i], d.rows[j]
		if a.anchor != b.anchor {
			return a.anchor < b.anchor
		}
		return a.phase < b.phase
	})
	out := make([]Change, len(d.rows))
	for i, r := range d.rows {
		out[i] = r.c
	}
	return out, d.warnings
}

func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// ── What a removal takes with it ─────────────────────────────────────────────

// removalDependents counts, per task, the live subtasks, timesheets and risk links
// a removal would take with it, so each removal row can say what goes with it.
//
// One query per count, each grouping the rows of every requested task at once: a
// preview offering a hundred removals is three round trips, not three hundred. A
// task with no rows of some kind simply does not appear in the result, and keeps
// the zero it was seeded with, so every requested task has an entry and a caller
// never reads a missing key as a count it did not ask for.
func removalDependents(ctx context.Context, ex orm.Executor, tenant uuid.UUID, tasks []uuid.UUID) (map[uuid.UUID]Dependents, error) {
	out := make(map[uuid.UUID]Dependents, len(tasks))
	for _, id := range tasks {
		out[id] = Dependents{}
	}
	if len(tasks) == 0 {
		return out, nil
	}
	counts := []struct {
		sql string
		set func(*Dependents, int)
	}{
		{`SELECT parent_id, count(*) FROM project_task
			WHERE tenant_id = $1 AND deleted_at IS NULL AND parent_id = ANY($2)
			GROUP BY parent_id`, func(d *Dependents, n int) { d.Subtasks = n }},
		{`SELECT task_id, count(*) FROM project_timesheet
			WHERE tenant_id = $1 AND deleted_at IS NULL AND task_id = ANY($2)
			GROUP BY task_id`, func(d *Dependents, n int) { d.Timesheets = n }},
		{`SELECT task_id, count(*) FROM project_risk_task
			WHERE tenant_id = $1 AND deleted_at IS NULL AND task_id = ANY($2)
			GROUP BY task_id`, func(d *Dependents, n int) { d.RiskLinks = n }},
	}
	for _, q := range counts {
		got, err := dependentCounts(ctx, ex, q.sql, tenant, tasks)
		if err != nil {
			return nil, err
		}
		for id, n := range got {
			entry := out[id]
			q.set(&entry, n)
			out[id] = entry
		}
	}
	return out, nil
}

// dependentCounts runs one of the three counts.
func dependentCounts(ctx context.Context, ex orm.Executor, sql string, tenant uuid.UUID, tasks []uuid.UUID) (map[uuid.UUID]int, error) {
	rows, err := ex.Query(ctx, sql, tenant, tasks)
	if err != nil {
		return nil, fmt.Errorf("count dependents: %w", err)
	}
	defer rows.Close()

	out := map[uuid.UUID]int{}
	for rows.Next() {
		var (
			id uuid.UUID
			n  int
		)
		if err := rows.Scan(&id, &n); err != nil {
			return nil, fmt.Errorf("count dependents: %w", err)
		}
		out[id] = n
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("count dependents: %w", err)
	}
	return out, nil
}
