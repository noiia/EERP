package project

import (
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

// The .gan format: GanttProject 3.x project files, an uncompressed XML document.
//
// The shape comes from a genuine GanttProject 3.3.3316 save, committed as
// testdata/gan/real_ganttproject_3.3.gan, and is discussed in
// docs/superpowers/specs/2026-11-18-project-gantt-exchange-design.md. Two rules
// come from that file rather than from the plan, and both matter:
//
//   - a <task> carries GanttProject's own uid attribute, a 32 hex id the app
//     keeps stable across saves. It is never ours: EERP identities are matched on
//     the eerp_id custom column only, never on uid and never on the name.
//   - <taskproperties> lists GanttProject's ten default columns before any custom
//     one, and the app renumbers the custom ones on save (in the reference file
//     they are tpd10 and tpd11, not the tpc0 and tpc1 EERP writes). Custom
//     properties are therefore resolved by column name, never by id.
//
// Everything the decoder has no field for is ignored, which is what makes a
// file's <view> blocks, <notes> CDATA and <vacations> harmless. The decoder
// never branches on version or locale either: it reads 3.x files as they come.

const (
	ganFormatKey = "gan"
	ganFormatExt = ".gan"
	ganRoot      = "project"

	// ganVersion is what the encoder writes. GanttProject only reads it to decide
	// whether an old file needs migrating, and never refuses a 3.x one; 3.3 is the
	// family of the reference file, without claiming its build number, which EERP
	// is not.
	ganVersion = "3.3"
	ganLocale  = "en_US"

	// ganMaxTasks is the import's ceiling, checked here because this is where the
	// file's size becomes data. It is the 5000 task cap of the spec's "Body size"
	// call: the upload limit is generous, this is what bounds a hostile file. The
	// cap is a product decision (an import that large is refused with 422), not a
	// defence against a hang: decoding 6000 tasks costs milliseconds.
	ganMaxTasks = 5000
	// ganMaxDurationDays bounds the duration and the dependency lag the decoder
	// accepts. It is the exchange's own ceiling for a working-day count, so the
	// file and the day loops cannot drift apart: a duration the decoder hands out
	// is one workdaysBetween and endAfter never saturate on (see maxWorkdayCount).
	// A duration past a hundred years is a hostile value, not a schedule.
	ganMaxDurationDays = maxWorkdayCount

	// The two columns EERP adds. GanttProject keeps custom columns across saves.
	ganEERPIDColumn    = "eerp_id"
	ganPlannedHoursCol = "planned_hours"
	// The ids the encoder gives them. The decoder never assumes them.
	ganEERPIDProp    = "tpc0"
	ganPlannedHoursP = "tpc1"

	// ganHardness is GanttProject's weakest dependency hardness, chosen on
	// purpose. With Strong, GanttProject silently reschedules a successor that
	// starts before its predecessor ends, and the real conflict in the EERP plan
	// never reaches the diff. With Rubber the successor keeps the date the file
	// holds, so EERP reports it as a date change and the manager sees the
	// conflict. The reference file says Strong because that is what the
	// GanttProject UI writes when a dependency is drawn by dragging; nothing reads
	// the attribute back.
	ganHardness = "Rubber"

	// The dependency type codes GanttProject writes.
	ganTypeSS = "1"
	ganTypeFS = "2"
	ganTypeFF = "3"
	ganTypeSF = "4"

	ganDayLayout = "2006-01-02"
)

// errNotGan marks "this is not a .gan file", which the route answers 422
// INVALID_FILE. A file that is .gan but carries something EERP cannot hold is
// not an error: it decodes and returns warnings.
var errNotGan = errors.New("not a GanttProject file")

// ganFormat is the GanttProject adapter. It holds no state; the registry keeps
// one value, registered from init below.
type ganFormat struct{}

func init() { registerFormat(ganFormat{}) }

func (ganFormat) Key() string { return ganFormatKey }
func (ganFormat) Ext() string { return ganFormatExt }

// Carries is what a .gan holds: no priority, notes, baselines or capacities, so
// a .gan import never reports those as cleared.
func (ganFormat) Carries(f Field) bool {
	switch f {
	case FieldName, FieldDates, FieldHours, FieldClosed, FieldMilestone:
		return true
	}
	return false
}

// The document, as far as EERP cares. Field order is attribute order on encode.
// Two elements of the real file are left out on purpose: <notes> (reading or
// writing notes is not part of the exchange) and the <view> blocks, which are
// GanttProject's own screen state.

type ganProjectEl struct {
	XMLName     xml.Name          `xml:"project"`
	Name        string            `xml:"name,attr"`
	Version     string            `xml:"version,attr,omitempty"`
	Locale      string            `xml:"locale,attr,omitempty"`
	Description *ganEmptyEl       `xml:"description,omitempty"`
	Calendars   *ganCalendarsEl   `xml:"calendars"`
	Tasks       *ganTasksEl       `xml:"tasks"`
	Resources   *ganResourcesEl   `xml:"resources"`
	Allocations *ganAllocationsEl `xml:"allocations"`
}

type ganEmptyEl struct{}

type ganCalendarsEl struct {
	DefaultWeek *ganWeekEl `xml:"day-types>default-week"`
	// GanttProject has written holiday dates both inside day-types and directly
	// under calendars, so both are read. Holiday dates are never written: EERP has
	// no calendar of them, and the import warns instead.
	InnerDates []ganDateEl `xml:"day-types>date"`
	Dates      []ganDateEl `xml:"date"`
}

// ganWeekEl is GanttProject's default-week element. "1" on a weekday means it is
// not worked, which is the opposite way round from Weekend's name, so the two
// conversions live next to each other.
type ganWeekEl struct {
	Sun string `xml:"sun,attr"`
	Mon string `xml:"mon,attr"`
	Tue string `xml:"tue,attr"`
	Wed string `xml:"wed,attr"`
	Thu string `xml:"thu,attr"`
	Fri string `xml:"fri,attr"`
	Sat string `xml:"sat,attr"`
}

type ganDateEl struct {
	Type string `xml:"type,attr"`
}

type ganTasksEl struct {
	EmptyMilestones string          `xml:"empty-milestones,attr,omitempty"`
	TaskProps       *ganTaskPropsEl `xml:"taskproperties"`
	Tasks           []ganTaskEl     `xml:"task"`
}

type ganTaskPropsEl struct {
	Props []ganPropEl `xml:"taskproperty"`
}

type ganPropEl struct {
	ID        string `xml:"id,attr"`
	Name      string `xml:"name,attr"`
	Type      string `xml:"type,attr,omitempty"`
	ValueType string `xml:"valuetype,attr,omitempty"`
}

type ganTaskEl struct {
	ID       string        `xml:"id,attr,omitempty"`
	Name     string        `xml:"name,attr,omitempty"`
	Meeting  string        `xml:"meeting,attr,omitempty"`
	Start    string        `xml:"start,attr,omitempty"`
	Duration string        `xml:"duration,attr,omitempty"`
	Complete string        `xml:"complete,attr,omitempty"`
	Expand   string        `xml:"expand,attr,omitempty"`
	Deps     []ganDepEl    `xml:"depend"`
	Props    []ganCustomEl `xml:"customproperty"`
	Children []ganTaskEl   `xml:"task"`
}

// ganDepEl sits on the predecessor and names its successor.
type ganDepEl struct {
	ID         string `xml:"id,attr"`
	Type       string `xml:"type,attr,omitempty"`
	Difference string `xml:"difference,attr,omitempty"`
	Hardness   string `xml:"hardness,attr,omitempty"`
}

type ganCustomEl struct {
	TaskPropertyID string `xml:"taskproperty-id,attr"`
	Value          string `xml:"value,attr"`
}

type ganResourcesEl struct {
	Resources []ganResourceEl `xml:"resource"`
}

type ganResourceEl struct {
	ID       string `xml:"id,attr"`
	Name     string `xml:"name,attr,omitempty"`
	Function string `xml:"function,attr,omitempty"`
	Contacts string `xml:"contacts,attr,omitempty"`
	Phone    string `xml:"phone,attr,omitempty"`
}

type ganAllocationsEl struct {
	Allocations []ganAllocEl `xml:"allocation"`
}

type ganAllocEl struct {
	TaskID      string `xml:"task-id,attr"`
	ResourceID  string `xml:"resource-id,attr"`
	Function    string `xml:"function,attr,omitempty"`
	Responsible string `xml:"responsible,attr,omitempty"`
	Load        string `xml:"load,attr,omitempty"`
}

// Decode reads a .gan into a Plan. Strict mode is what turns a truncated file, or
// one trying to smuggle an entity definition in, into an error: Go's
// encoding/xml never expands a declared entity, custom or external, so a
// billion-laughs file comes back as errNotGan rather than as an expanded name.
func (ganFormat) Decode(r io.Reader) (Plan, []Warning, error) {
	dec := xml.NewDecoder(r)
	dec.Strict = true

	root, err := ganRootElement(dec)
	if err != nil {
		return Plan{}, nil, err
	}
	var doc ganProjectEl
	if err := dec.DecodeElement(&doc, &root); err != nil {
		return Plan{}, nil, fmt.Errorf("%w: %v", errNotGan, err)
	}
	return doc.toPlan()
}

// ganRootElement steps over the declaration, comments and whitespace, and insists
// that the first element is <project>. Anything else (an MSPDI file, an HTML
// page, half a file) is not this format.
func ganRootElement(dec *xml.Decoder) (xml.StartElement, error) {
	for {
		tok, err := dec.Token()
		if err != nil {
			return xml.StartElement{}, fmt.Errorf("%w: %v", errNotGan, err)
		}
		if start, ok := tok.(xml.StartElement); ok {
			if start.Name.Local != ganRoot {
				return xml.StartElement{}, fmt.Errorf("%w: root element is <%s>", errNotGan, start.Name.Local)
			}
			return start, nil
		}
	}
}

// toPlan turns the document into the neutral model.
func (doc *ganProjectEl) toPlan() (Plan, []Warning, error) {
	p := Plan{Name: doc.Name, Weekend: DefaultWeekend}
	var warnings []Warning

	calendarWarnings, err := doc.calendar(&p)
	if err != nil {
		return Plan{}, nil, err
	}
	warnings = append(warnings, calendarWarnings...)

	w := ganWalker{columns: doc.Tasks.columnByName(), byFileID: map[string]string{}}
	if doc.Tasks != nil {
		for _, task := range doc.Tasks.Tasks {
			if err := w.walk(task, ""); err != nil {
				return Plan{}, nil, err
			}
		}
	}
	warnings = append(warnings, w.warnings...)
	// Milestones are hoisted last so that a decoded Plan is in the order the
	// encoder writes, which is what makes a file read back as it was written.
	p.Tasks = append(w.tasks, w.milestones...)

	for _, pending := range w.pending {
		succ, ok := w.byFileID[pending.dep.ID]
		if !ok {
			// A dependency to a row the file does not have: nothing to point at.
			continue
		}
		p.Deps = append(p.Deps, PlanDep{
			Pred: pending.pred,
			Succ: succ,
			Type: ganDepType(pending.dep.Type),
			Lag:  ganInt(pending.dep.Difference, 0, ganMaxDurationDays),
		})
	}
	p.Assignments = doc.assignments(w.byFileID)

	return p, warnings, nil
}

// ganWalker walks the task tree in document order. A parent is visited before its
// children, so its Key is known when they are read.
type ganWalker struct {
	// columns maps each EERP column name to the taskproperty id this file uses.
	columns    map[string]string
	tasks      []PlanTask
	milestones []PlanTask
	byFileID   map[string]string
	pending    []ganPendingDep
	// warnings holds what the rows themselves could not be read as, in document
	// order. The calendar's warnings come before them.
	warnings []Warning
}

type ganPendingDep struct {
	pred string
	dep  ganDepEl
}

func (w *ganWalker) walk(el ganTaskEl, parentKey string) error {
	if len(w.tasks)+len(w.milestones) >= ganMaxTasks {
		return fmt.Errorf("%w: %w: more than %d tasks", errNotGan, errPlanTooBig, ganMaxTasks)
	}
	// The file's own id is what a row is named by: Key() falls back to it for a
	// row EERP does not know, and Parent, PlanDep and PlanAssign all hold Key()s.
	// Two rows without one would share the key "new:" and one of them would be
	// lost. GanttProject always numbers its rows, so a <task> with no id is a
	// corrupt file rather than a task EERP could import.
	if el.ID == "" {
		return fmt.Errorf("%w: a <task> has no id attribute", errNotGan)
	}

	ref := w.eerpRef(el)

	task := PlanTask{
		Ref:          ref,
		FileID:       el.ID,
		Name:         el.Name,
		Start:        ganDay(el.Start),
		Duration:     ganInt(el.Duration, 0, ganMaxDurationDays),
		PlannedHours: ganHours(el, w, ganPlannedHoursCol),
		Complete:     ganInt(el.Complete, 0, 100),
		Milestone:    ganTrue(el.Meeting),
		HasChildren:  len(el.Children) > 0,
	}
	// A milestone is a top level entity in EERP, so one that GanttProject shows
	// under a task is read at the top level, and its duration is always 0. That is
	// how EERP's own WBS shows a milestone, so it is not a warning.
	if task.Milestone {
		task.Parent = ""
		task.Duration = 0
		w.milestones = append(w.milestones, task)
	} else {
		task.Parent = parentKey
		w.tasks = append(w.tasks, task)
	}

	key := task.Key()
	if _, dup := w.byFileID[el.ID]; !dup {
		w.byFileID[el.ID] = key
	}
	for _, dep := range el.Deps {
		w.pending = append(w.pending, ganPendingDep{pred: key, dep: dep})
	}

	for _, child := range el.Children {
		if err := w.walk(child, key); err != nil {
			return err
		}
	}
	return nil
}

// columnByName maps the columns EERP owns to the ids this file gave them.
func (t *ganTasksEl) columnByName() map[string]string {
	if t == nil || t.TaskProps == nil {
		return nil
	}
	out := map[string]string{}
	for _, prop := range t.TaskProps.Props {
		switch prop.Name {
		case ganEERPIDColumn, ganPlannedHoursCol:
			if _, dup := out[prop.Name]; !dup {
				out[prop.Name] = prop.ID
			}
		}
	}
	return out
}

// column reads one of EERP's custom properties off a task, through the id this
// file gave that column.
func (w *ganWalker) column(el ganTaskEl, name string) string {
	id, ok := w.columns[name]
	if !ok || id == "" {
		return ""
	}
	for _, prop := range el.Props {
		if prop.TaskPropertyID == id {
			return prop.Value
		}
	}
	return ""
}

// calendar applies the file's <calendars> block to p: the working week, and the
// one thing about it EERP cannot hold. A file with no <default-week> leaves the
// caller's DefaultWeekend in place.
//
// A mask that works no day (<default-week sun="1" ... sat="1"/>) is refused
// rather than degraded. It states a calendar with no working day at all, so the
// file holds no schedule to import: any duration at all runs past every horizon.
// GanttProject never writes one, its UI keeps at least one day worked. Degrading
// it to a five-day week would be the decoder inventing the one thing it never
// invents, a calendar the partner did not write, and the nine warning codes have
// nothing to say about it. So it is "not a .gan file", which the route answers
// 422 INVALID_FILE. The day loops are bounded on their own whatever the mask
// (see maxWorkdayScan); this is the layer above them, refusing the file rather
// than importing a plan no calendar can schedule.
func (doc *ganProjectEl) calendar(p *Plan) ([]Warning, error) {
	if doc.Calendars == nil {
		return nil, nil
	}
	mask, ok := doc.Calendars.weekend()
	if ok {
		if !mask.hasWorkedDay() {
			return nil, fmt.Errorf("%w: <default-week> works no day", errNotGan)
		}
		p.Weekend = mask
	}
	if !doc.Calendars.hasHoliday() {
		return nil, nil
	}
	p.HasHolidays = true
	return []Warning{{
		Code:    "HOLIDAYS",
		Message: "the file defines holidays; only its weekends are used",
	}}, nil
}

// eerpRef reads one row's EERP identity off the file's custom column. An absent
// value is the normal case for a task the partner added. A value that is not an
// EERP identity at all (see validRef) is dropped, and the row becomes an ordinary
// create keyed on its own file id: that is how a foreign id is already read, and
// it is what keeps a hand-written eerp_id="new:7" from being handed the Key() of
// another row, which would make that row vanish from the diff. The warning is the
// one the diff raises for an id this project does not know, so the file never
// passes for an identity EERP cannot have.
func (w *ganWalker) eerpRef(el ganTaskEl) string {
	// Trimmed the way the other column EERP owns is (see ganHours): an empty cell
	// is how GanttProject writes a row nobody gave an id to, and a stray space does
	// not make it a different identity.
	ref := strings.TrimSpace(w.column(el, ganEERPIDColumn))
	if ref == "" {
		return ""
	}
	if validRef(ref) {
		return canonicalRef(ref)
	}
	w.warnings = append(w.warnings, Warning{
		Code:    "UNKNOWN_ID",
		Message: "the file's eerp_id is not an EERP id; the task is imported as a new task",
		Task:    el.Name,
	})
	return ""
}

// canonicalRef writes an accepted eerp_id the one way EERP writes it. A UUID is
// case-insensitive, so a partner editing the XML by hand (or a tool that upper-cases
// ids) means the same task by AAAAAAAA-... and aaaaaaaa-...; the loader reads ids out
// of Postgres, which spells them lower-case, and the diff matches on the string. Without
// this step the second spelling would name nothing and the task would be imported as a
// duplicate of itself. The milestone: prefix is kept as validRef read it.
func canonicalRef(ref string) string {
	id, isMilestone := strings.CutPrefix(ref, milestoneRefPrefix)
	if !isMilestone {
		id = ref
	}
	// validRef has just parsed this, so the parse cannot fail here; returning ref
	// unchanged keeps this a formatting helper rather than a second gatekeeper.
	parsed, err := uuid.Parse(id)
	if err != nil {
		return ref
	}
	if isMilestone {
		return milestoneRefPrefix + parsed.String()
	}
	return parsed.String()
}

// weekend reads the file's calendar. ok is false when the file has no
// default-week element, leaving the caller's default in place.
func (c *ganCalendarsEl) weekend() (Weekend, bool) {
	if c.DefaultWeek == nil {
		return Weekend{}, false
	}
	return Weekend{
		int(time.Sunday):    ganTrue(c.DefaultWeek.Sun),
		int(time.Monday):    ganTrue(c.DefaultWeek.Mon),
		int(time.Tuesday):   ganTrue(c.DefaultWeek.Tue),
		int(time.Wednesday): ganTrue(c.DefaultWeek.Wed),
		int(time.Thursday):  ganTrue(c.DefaultWeek.Thu),
		int(time.Friday):    ganTrue(c.DefaultWeek.Fri),
		int(time.Saturday):  ganTrue(c.DefaultWeek.Sat),
	}, true
}

// hasHoliday reports whether the file declares a holiday. A NEWORKINGDAY, the
// other type GanttProject writes, is a day added to the working week rather than
// one taken off it; neither is modelled, so neither warns.
func (c *ganCalendarsEl) hasHoliday() bool {
	if ganHoliday(c.InnerDates) || ganHoliday(c.Dates) {
		return true
	}
	return false
}

func ganHoliday(dates []ganDateEl) bool {
	for _, d := range dates {
		if d.Type == "HOLIDAY" {
			return true
		}
	}
	return false
}

// assignments pairs each allocation with its task and its resource. An allocation
// pointing at a task or a resource the file does not have is dropped: there is
// nothing to assign. The same person allocated twice to the same task is one
// assignment, which is also how the encoder writes them back.
func (doc *ganProjectEl) assignments(byFileID map[string]string) []PlanAssign {
	if doc.Resources == nil || doc.Allocations == nil {
		return nil
	}
	resources := map[string]ganResourceEl{}
	for _, r := range doc.Resources.Resources {
		if r.ID == "" {
			continue
		}
		if _, dup := resources[r.ID]; !dup {
			resources[r.ID] = r
		}
	}
	var out []PlanAssign
	seen := map[PlanAssign]bool{}
	for _, a := range doc.Allocations.Allocations {
		task, ok := byFileID[a.TaskID]
		if !ok {
			continue
		}
		r, ok := resources[a.ResourceID]
		if !ok {
			continue
		}
		assign := PlanAssign{Task: task, Email: r.Contacts, Name: r.Name}
		if seen[assign] {
			continue
		}
		seen[assign] = true
		out = append(out, assign)
	}
	return out
}

// Encode writes the file. Task ids are 1..n in document order with milestones
// last, which is the order Plan promises and the order the decoder normalises
// back to, so a file EERP writes reads back as the same Plan.
func (ganFormat) Encode(w io.Writer, p Plan) error {
	if _, err := io.WriteString(w, xml.Header); err != nil {
		return err
	}
	enc := xml.NewEncoder(w)
	enc.Indent("", "    ")
	if err := enc.Encode(ganDocument(p)); err != nil {
		return fmt.Errorf("encode %s: %w", ganFormatExt, err)
	}
	if err := enc.Flush(); err != nil {
		return fmt.Errorf("encode %s: %w", ganFormatExt, err)
	}
	_, err := io.WriteString(w, "\n")
	return err
}

// ganDocument builds the whole file in the shape GanttProject expects.
func ganDocument(p Plan) *ganProjectEl {
	order := ganEncodeOrder(p)

	// The number each task gets in document order, and its place in that order. A
	// Key shared by two rows (a copy-pasted eerp_id, which the diff reports as
	// DUPLICATE_ID) belongs to the first one: dependencies and parents point
	// there, and only that row carries them.
	ids := map[string]string{}
	index := map[string]int{}
	for i, task := range order {
		key := task.Key()
		if _, dup := ids[key]; dup {
			continue
		}
		ids[key] = strconv.Itoa(i + 1)
		index[key] = i
	}
	deps := ganDepIndex(p, ids)

	// Where each row hangs: its parent's place in the canonical order, or -1 for
	// the top level. A Plan read from the database or from a file is a tree; one
	// handed to the writer by a bug need not be, and a loop here would be a
	// stack overflow in a request, so the loops are cut before anything is linked.
	parent := make([]int, len(order))
	for i, task := range order {
		parent[i] = -1
		if task.Parent == "" {
			continue
		}
		// A row that is its own parent is a row with no parent.
		if p, linked := index[task.Parent]; linked && p != i {
			parent[i] = p
		}
	}
	ganBreakCycles(parent)

	nodes := make([]*ganNode, len(order))
	for i, task := range order {
		key := task.Key()
		own := ids[key] == strconv.Itoa(i+1)
		var row []ganDepEl
		if own {
			row = deps[key]
		}
		nodes[i] = &ganNode{i: i, el: ganTaskElement(task, strconv.Itoa(i+1), row)}
	}
	var roots []*ganNode
	for i := range nodes {
		if parent[i] < 0 {
			roots = append(roots, nodes[i])
			continue
		}
		p := nodes[parent[i]]
		p.children = append(p.children, nodes[i])
	}

	var tasks []ganTaskEl
	for _, root := range roots {
		tasks = append(tasks, root.build(map[int]bool{}))
	}

	resources, allocations := ganEncodePeople(p, ids)

	return &ganProjectEl{
		Name:        p.Name,
		Version:     ganVersion,
		Locale:      ganLocale,
		Description: &ganEmptyEl{},
		Calendars:   &ganCalendarsEl{DefaultWeek: ganWeekElement(p.Weekend)},
		Tasks: &ganTasksEl{
			EmptyMilestones: "true",
			TaskProps: &ganTaskPropsEl{Props: []ganPropEl{
				{ID: ganEERPIDProp, Name: ganEERPIDColumn, Type: "custom", ValueType: "text"},
				{ID: ganPlannedHoursP, Name: ganPlannedHoursCol, Type: "custom", ValueType: "double"},
			}},
			Tasks: tasks,
		},
		Resources:   &ganResourcesEl{Resources: resources},
		Allocations: &ganAllocationsEl{Allocations: allocations},
	}
}

// ganNode is a task element with its children, so that the tree can be linked
// before it is flattened into the value form encoding/xml wants.
type ganNode struct {
	i        int
	el       *ganTaskEl
	children []*ganNode
}

// ganBreakCycles turns Parent links that loop into top level rows: one row of
// each loop loses its parent, so what the writer walks is a forest. A Plan read
// from the database or from a .gan is already a tree; this is the belt on the
// harness, because a loop here would be a stack overflow in a request. Rows
// hanging below a loop keep their parent.
func ganBreakCycles(parent []int) {
	const (
		unvisited = 0
		onPath    = 1
		done      = 2
	)
	state := make([]int, len(parent))
	for i := range parent {
		if state[i] != unvisited {
			continue
		}
		var path []int
		pos := map[int]int{}
		cur := i
		for cur >= 0 && state[cur] == unvisited {
			state[cur] = onPath
			pos[cur] = len(path)
			path = append(path, cur)
			cur = parent[cur]
		}
		if cur >= 0 && state[cur] == onPath {
			// The walk came back onto itself: everything from the repeat onwards is
			// the loop, and each of its rows becomes top level.
			for _, n := range path[pos[cur]:] {
				parent[n] = -1
			}
		}
		for _, n := range path {
			state[n] = done
		}
	}
}

// build flattens the subtree. open holds the nodes on the current path: ganBreakCycles
// has already cut the loops a Plan's Parent links could hold, and this is the
// second cut behind it, so a missed one ends the row instead of the process.
func (n *ganNode) build(open map[int]bool) ganTaskEl {
	el := *n.el
	if open[n.i] {
		return el
	}
	open[n.i] = true
	for _, child := range n.children {
		el.Children = append(el.Children, child.build(open))
	}
	delete(open, n.i)
	return el
}

// ganEncodeOrder is the canonical document order Plan promises: the tasks as
// given, then the milestones.
func ganEncodeOrder(p Plan) []PlanTask {
	order := make([]PlanTask, 0, len(p.Tasks))
	var milestones []PlanTask
	for _, task := range p.Tasks {
		if task.Milestone {
			milestones = append(milestones, task)
			continue
		}
		order = append(order, task)
	}
	return append(order, milestones...)
}

// ganTaskElement writes one row. Both custom columns are always there, so that
// GanttProject keeps them; an empty eerp_id is what marks a row as new.
func ganTaskElement(task PlanTask, id string, deps []ganDepEl) *ganTaskEl {
	meeting := "false"
	if task.Milestone {
		meeting = "true"
	}
	start := ""
	if !task.Start.IsZero() {
		start = day(task.Start).Format(ganDayLayout)
	}
	el := &ganTaskEl{
		ID:       id,
		Name:     task.Name,
		Meeting:  meeting,
		Start:    start,
		Duration: strconv.Itoa(ganClamp(ganZeroIfMilestone(task), 0, ganMaxDurationDays)),
		Complete: strconv.Itoa(ganClamp(task.Complete, 0, 100)),
		Expand:   "true",
		Deps:     deps,
	}
	if task.Collapsed {
		el.Expand = "false"
	}
	if task.Ref != "" {
		el.Props = append(el.Props, ganCustomEl{TaskPropertyID: ganEERPIDProp, Value: task.Ref})
	}
	el.Props = append(el.Props, ganCustomEl{TaskPropertyID: ganPlannedHoursP, Value: ganFormatHours(task.PlannedHours)})
	return el
}

func ganZeroIfMilestone(task PlanTask) int {
	if task.Milestone {
		return 0
	}
	return task.Duration
}

// ganDepIndex groups the dependencies by predecessor, keeping the plan's order
// inside each group. A dependency reaching past the plan cannot be written, so it
// is left out; GanttProject puts each <depend> on its predecessor.
func ganDepIndex(p Plan, ids map[string]string) map[string][]ganDepEl {
	out := map[string][]ganDepEl{}
	// GanttProject refuses a link between a task and its own summary task ("is looping").
	nested := p.nestedDeps()
	for i, dep := range p.Deps {
		if nested[i] {
			continue
		}
		if _, ok := ids[dep.Pred]; !ok {
			continue
		}
		succID, ok := ids[dep.Succ]
		if !ok {
			continue
		}
		out[dep.Pred] = append(out[dep.Pred], ganDepEl{
			ID:         succID,
			Type:       ganDepCode(dep.Type),
			Difference: strconv.Itoa(ganClamp(dep.Lag, 0, ganMaxDurationDays)),
			Hardness:   ganHardness,
		})
	}
	return out
}

// ganEncodePeople numbers the resources the file needs, one per distinct person,
// and pairs each with the tasks they are on.
func ganEncodePeople(p Plan, ids map[string]string) ([]ganResourceEl, []ganAllocEl) {
	var resources []ganResourceEl
	var allocations []ganAllocEl
	people := map[ganPerson]string{}
	for _, assign := range p.Assignments {
		taskID, ok := ids[assign.Task]
		if !ok {
			continue
		}
		person := ganPerson{email: assign.Email, name: assign.Name}
		resID, known := people[person]
		if !known {
			resID = strconv.Itoa(len(resources) + 1)
			people[person] = resID
			resources = append(resources, ganResourceEl{
				ID:       resID,
				Name:     assign.Name,
				Function: "Default:0",
				Contacts: assign.Email,
			})
		}
		allocations = append(allocations, ganAllocEl{
			TaskID:      taskID,
			ResourceID:  resID,
			Function:    "Default:0",
			Responsible: "true",
			Load:        "100.0",
		})
	}
	return resources, allocations
}

// ganPerson is who a resource stands for: the file has no staff id, only the
// email and the label the partner typed.
type ganPerson struct {
	email, name string
}

func ganWeekElement(w Weekend) *ganWeekEl {
	// An unset mask (nothing off) would claim a seven day working week, which no
	// EERP plan means; write GanttProject's own default instead.
	if w == (Weekend{}) {
		w = DefaultWeekend
	}
	on := func(weekday time.Weekday) string {
		if w[weekday] {
			return "1"
		}
		return "0"
	}
	return &ganWeekEl{
		Sun: on(time.Sunday), Mon: on(time.Monday), Tue: on(time.Tuesday),
		Wed: on(time.Wednesday), Thu: on(time.Thursday), Fri: on(time.Friday),
		Sat: on(time.Saturday),
	}
}

// The readers. Each turns an absent or hostile value into something the Plan can
// hold, without inventing a date, a duration, or an identity.

// ganDay parses the file's whole-day date as UTC midnight. An absent or unparsable
// start stays the zero day: GanttProject always writes one, so a file without it
// is corrupt, and the diff then reports a date the partner did not set rather than
// one EERP made up.
func ganDay(value string) time.Time {
	t, err := time.Parse(ganDayLayout, value)
	if err != nil {
		return time.Time{}
	}
	return t
}

// ganInt parses an attribute that must be a number, clamped into [lo, hi]. An
// absent or garbage value is lo, which is also what GanttProject shows for an
// empty cell.
func ganInt(value string, lo, hi int) int {
	n, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil {
		return lo
	}
	return ganClamp(n, lo, hi)
}

func ganClamp(n, lo, hi int) int {
	if n < lo {
		return lo
	}
	if n > hi {
		return hi
	}
	return n
}

// ganHours reads the planned_hours column. GanttProject writes an empty value for
// a row nobody filled in.
func ganHours(el ganTaskEl, w *ganWalker, column string) float64 {
	raw := strings.TrimSpace(w.column(el, column))
	if raw == "" {
		return 0
	}
	hours, err := strconv.ParseFloat(raw, 64)
	if err != nil || math.IsNaN(hours) || math.IsInf(hours, 0) {
		return 0
	}
	return hours
}

// ganFormatHours writes the shortest form that parses back to the same float64,
// which is what keeps the round trip exact at the 0.01 the diff compares at.
func ganFormatHours(hours float64) string {
	if math.IsNaN(hours) || math.IsInf(hours, 0) {
		return "0"
	}
	return strconv.FormatFloat(hours, 'f', -1, 64)
}

func ganTrue(value string) bool {
	return value == "1" || strings.EqualFold(value, "true")
}

func ganDepType(code string) DepType {
	switch code {
	case ganTypeSS:
		return DepSS
	case ganTypeFF:
		return DepFF
	case ganTypeSF:
		return DepSF
	default:
		// Absent or unknown: the type GanttProject uses by default, and the only
		// one EERP can hold anyway.
		return DepFS
	}
}

func ganDepCode(t DepType) string {
	switch t {
	case DepSS:
		return ganTypeSS
	case DepFF:
		return ganTypeFF
	case DepSF:
		return ganTypeSF
	default:
		return ganTypeFS
	}
}
