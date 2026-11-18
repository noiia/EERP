package project

import (
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// The ids basic.gan and partner_edited.gan carry. They are made up, but they
// are the same strings in the fixtures and here.
const (
	ganFoundationRef     = "11111111-1111-4111-8111-111111111111"
	ganExcavationRef     = "22222222-2222-4222-8222-222222222222"
	ganConcreteRef       = "33333333-3333-4333-8333-333333333333"
	ganSuperstructureRef = "44444444-4444-4444-8444-444444444444"
	ganFramingRef        = "55555555-5555-4555-8555-555555555555"
	ganStructureRef      = "milestone:66666666-6666-4666-8666-666666666666"

	ganAlphaRef   = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	ganLongRef    = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	ganCharlieRef = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
	ganGateRef    = "milestone:dddddddd-dddd-4ddd-8ddd-dddddddddddd"

	// The plans the encoder tests build in code carry uuid-shaped refs too, because
	// that is what EERP writes and what the decoder reads back as an identity: an
	// eerp_id of any other shape comes back as a new row (see validRef), which
	// would silently break a round trip that is meant to be exact.
	ganRoundA      = "eeeeeeee-0000-4000-8000-000000000001"
	ganRoundB      = "eeeeeeee-0000-4000-8000-000000000002"
	ganRoundC      = "eeeeeeee-0000-4000-8000-000000000003"
	ganRoundGate   = "milestone:eeeeeeee-0000-4000-8000-000000000004"
	ganRoundDupRef = "eeeeeeee-0000-4000-8000-000000000005"
)

func ganDecodeFile(t *testing.T, name string) (Plan, []Warning) {
	t.Helper()
	f, err := os.Open(filepath.Join("testdata", "gan", name))
	if err != nil {
		t.Fatalf("open fixture: %v", err)
	}
	defer f.Close()
	p, warnings, err := ganFormat{}.Decode(f)
	if err != nil {
		t.Fatalf("Decode(%s): %v", name, err)
	}
	return p, warnings
}

func ganDecodeString(t *testing.T, doc string) (Plan, []Warning, error) {
	t.Helper()
	return ganFormat{}.Decode(strings.NewReader(doc))
}

// ganTask finds a decoded task by its Key.
func ganTask(t *testing.T, p Plan, key string) PlanTask {
	t.Helper()
	for _, task := range p.Tasks {
		if task.Key() == key {
			return task
		}
	}
	t.Fatalf("no task with key %q in %d tasks", key, len(p.Tasks))
	return PlanTask{}
}

// ganWantOrder fails unless the plan's tasks are exactly these keys, in order.
func ganWantOrder(t *testing.T, p Plan, want ...string) {
	t.Helper()
	got := make([]string, len(p.Tasks))
	for i, task := range p.Tasks {
		got[i] = task.Key()
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("task order = %v, want %v", got, want)
	}
}

func TestGanFormat(t *testing.T) {
	f, ok := formatByKey("gan")
	if !ok {
		t.Fatal(`formatByKey("gan") = !ok, want the adapter registered by init`)
	}
	if f.Key() != "gan" {
		t.Errorf("Key() = %q, want gan", f.Key())
	}
	if f.Ext() != ".gan" {
		t.Errorf("Ext() = %q, want .gan", f.Ext())
	}
}

func TestGanDecode_Basic(t *testing.T) {
	p, warnings := ganDecodeFile(t, "basic.gan")

	if len(warnings) != 0 {
		t.Errorf("warnings = %+v, want none", warnings)
	}
	if p.Name != "House build" {
		t.Errorf("Name = %q, want %q", p.Name, "House build")
	}
	if p.Weekend != DefaultWeekend {
		t.Errorf("Weekend = %v, want DefaultWeekend", p.Weekend)
	}
	if p.HasHolidays {
		t.Error("HasHolidays = true, want false")
	}

	// Pre-order, with the milestone last.
	ganWantOrder(t, p, ganFoundationRef, ganExcavationRef, ganConcreteRef,
		ganSuperstructureRef, ganFramingRef, ganStructureRef)

	foundation := ganTask(t, p, ganFoundationRef)
	if !foundation.HasChildren {
		t.Error("Foundation: HasChildren = false, want true")
	}
	if foundation.Parent != "" {
		t.Errorf("Foundation: Parent = %q, want top level", foundation.Parent)
	}
	if !foundation.Start.Equal(exchangeDay(2026, time.January, 5)) {
		t.Errorf("Foundation: Start = %v, want 2026-01-05", foundation.Start)
	}
	if foundation.Start.Location() != time.UTC || foundation.Start.Format("15:04") != "00:00" {
		t.Errorf("Foundation: Start = %s, want UTC midnight", foundation.Start)
	}
	if foundation.Duration != 5 {
		t.Errorf("Foundation: Duration = %d, want 5", foundation.Duration)
	}
	if foundation.PlannedHours != 24 {
		t.Errorf("Foundation: PlannedHours = %v, want 24", foundation.PlannedHours)
	}
	if foundation.FileID != "1" {
		t.Errorf("Foundation: FileID = %q, want 1", foundation.FileID)
	}

	// A child carries its parent's Key, not its file id.
	excavation := ganTask(t, p, ganExcavationRef)
	if excavation.Parent != ganFoundationRef {
		t.Errorf("Excavation: Parent = %q, want %q", excavation.Parent, ganFoundationRef)
	}
	if excavation.HasChildren {
		t.Error("Excavation: HasChildren = true, want false")
	}
	if excavation.PlannedHours != 12 {
		t.Errorf("Excavation: PlannedHours = %v, want 12 (the custom planned_hours column)", excavation.PlannedHours)
	}

	concrete := ganTask(t, p, ganConcreteRef)
	if concrete.Complete != 100 {
		t.Errorf("Concrete pour: Complete = %d, want 100", concrete.Complete)
	}
	if concrete.Parent != ganFoundationRef {
		t.Errorf("Concrete pour: Parent = %q, want %q", concrete.Parent, ganFoundationRef)
	}

	// The milestone is a milestone, read at the top level, with its prefix kept.
	milestone := p.Tasks[len(p.Tasks)-1]
	if !milestone.Milestone {
		t.Error("milestone: Milestone = false, want true (meeting=\"true\")")
	}
	if milestone.Ref != ganStructureRef {
		t.Errorf("milestone: Ref = %q, want %q (the milestone: prefix survives)", milestone.Ref, ganStructureRef)
	}
	if milestone.Parent != "" {
		t.Errorf("milestone: Parent = %q, want top level", milestone.Parent)
	}
	if milestone.Duration != 0 {
		t.Errorf("milestone: Duration = %d, want 0", milestone.Duration)
	}

	wantDeps := []PlanDep{
		{Pred: ganConcreteRef, Succ: ganFramingRef, Type: DepFS, Lag: 0},
		{Pred: ganFramingRef, Succ: ganStructureRef, Type: DepFS, Lag: 0},
	}
	if !reflect.DeepEqual(p.Deps, wantDeps) {
		t.Errorf("Deps = %+v, want %+v", p.Deps, wantDeps)
	}

	wantAssigns := []PlanAssign{{Task: ganFramingRef, Email: "ann@x.com", Name: "Ann Lee"}}
	if !reflect.DeepEqual(p.Assignments, wantAssigns) {
		t.Errorf("Assignments = %+v, want %+v", p.Assignments, wantAssigns)
	}
}

func TestGanDecode_PartnerEdited(t *testing.T) {
	p, warnings := ganDecodeFile(t, "partner_edited.gan")
	if len(warnings) != 0 {
		t.Errorf("warnings = %+v, want none", warnings)
	}

	// "Concrete pour" is gone; the new task is there under Superstructure.
	ganWantOrder(t, p, ganFoundationRef, ganExcavationRef, ganSuperstructureRef,
		ganFramingRef, "new:7", ganStructureRef)

	if _, found := findGanTask(p, ganConcreteRef); found {
		t.Error("Concrete pour is still in the plan, want it removed with the file")
	}

	// The deadline the partner moved.
	framing := ganTask(t, p, ganFramingRef)
	if !framing.Start.Equal(exchangeDay(2026, time.January, 19)) {
		t.Errorf("Framing: Start = %v, want 2026-01-19 (the partner moved it)", framing.Start)
	}

	// The new task has no eerp_id, so it is a create keyed on its file id.
	fresh := ganTask(t, p, "new:7")
	if fresh.Ref != "" {
		t.Errorf("Safety inspection: Ref = %q, want empty for a task the file added", fresh.Ref)
	}
	if fresh.Name != "Safety inspection" {
		t.Errorf("Safety inspection: Name = %q", fresh.Name)
	}
	if fresh.Parent != ganSuperstructureRef {
		t.Errorf("Safety inspection: Parent = %q, want %q", fresh.Parent, ganSuperstructureRef)
	}
	if fresh.PlannedHours != 0 {
		t.Errorf("Safety inspection: PlannedHours = %v, want 0 for an empty custom column", fresh.PlannedHours)
	}

	// The two custom columns were renumbered by GanttProject (tpd10, tpd11):
	// reading them by name is what keeps the values alive.
	if got := ganTask(t, p, ganExcavationRef).PlannedHours; got != 12 {
		t.Errorf("Excavation: PlannedHours = %v, want 12 read through the renumbered tpd11 column", got)
	}
	if got := ganTask(t, p, ganFoundationRef); got.Milestone {
		t.Error("Foundation: Milestone = true, want false")
	}

	if super := ganTask(t, p, ganSuperstructureRef); !super.HasChildren {
		t.Error("Superstructure: HasChildren = false, want true")
	}

	wantDeps := []PlanDep{
		{Pred: ganFramingRef, Succ: ganStructureRef, Type: DepFS, Lag: 0},
		{Pred: ganFramingRef, Succ: "new:7", Type: DepFS, Lag: 0},
	}
	if !reflect.DeepEqual(p.Deps, wantDeps) {
		t.Errorf("Deps = %+v, want %+v (the dependency Concrete pour carried is gone, the new one is in)", p.Deps, wantDeps)
	}

	wantAssigns := []PlanAssign{{Task: ganFramingRef, Email: "ann@x.com", Name: "Ann Lee"}}
	if !reflect.DeepEqual(p.Assignments, wantAssigns) {
		t.Errorf("Assignments = %+v, want %+v", p.Assignments, wantAssigns)
	}
}

func findGanTask(p Plan, key string) (PlanTask, bool) {
	for _, task := range p.Tasks {
		if task.Key() == key {
			return task, true
		}
	}
	return PlanTask{}, false
}

func TestGanDecode_Odd(t *testing.T) {
	p, warnings := ganDecodeFile(t, "odd.gan")

	// A file with holidays is read with weekends only, and says so.
	wantWeekend := Weekend{time.Friday: true, time.Saturday: true, time.Sunday: true}
	if p.Weekend != wantWeekend {
		t.Errorf("Weekend = %v, want %v (read from the file, not defaulted)", p.Weekend, wantWeekend)
	}
	if !p.HasHolidays {
		t.Error("HasHolidays = false, want true")
	}
	if len(warnings) != 1 || warnings[0].Code != "HOLIDAYS" {
		t.Errorf("warnings = %+v, want one HOLIDAYS warning (the rest are the diff's)", warnings)
	}

	ganWantOrder(t, p, ganAlphaRef, ganLongRef, ganCharlieRef, ganCharlieRef, ganGateRef)

	// The over-long name arrives whole: truncating it is the diff's call.
	long := ganTask(t, p, ganLongRef)
	if len(long.Name) != 250 {
		t.Errorf("long name: len = %d, want 250 (decode does not truncate)", len(long.Name))
	}
	if !strings.HasPrefix(long.Name, "0123456789") {
		t.Errorf("long name: %q, want the 250 character name verbatim", long.Name[:min(len(long.Name), 20)])
	}

	// Two rows share one eerp_id; decode stays faithful, the diff warns.
	dups := 0
	for _, task := range p.Tasks {
		if task.Key() == ganCharlieRef {
			dups++
		}
	}
	if dups != 2 {
		t.Errorf("%d tasks key on %q, want 2 (a duplicated eerp_id is the diff's DUPLICATE_ID)", dups, ganCharlieRef)
	}

	milestone := p.Tasks[len(p.Tasks)-1]
	if !milestone.Milestone {
		t.Error("Gate: Milestone = false, want true")
	}

	wantDeps := []PlanDep{
		{Pred: ganAlphaRef, Succ: ganLongRef, Type: DepSS, Lag: 0},
		{Pred: ganLongRef, Succ: ganCharlieRef, Type: DepFS, Lag: 2},
		{Pred: ganGateRef, Succ: ganCharlieRef, Type: DepFS, Lag: 0},
	}
	if !reflect.DeepEqual(p.Deps, wantDeps) {
		t.Errorf("Deps = %+v, want %+v", p.Deps, wantDeps)
	}
	if p.Deps[0].Type != DepSS {
		t.Errorf("first dep type = %v, want DepSS (type 1)", p.Deps[0].Type)
	}
	if p.Deps[1].Lag != 2 {
		t.Errorf("second dep lag = %d, want 2 (difference=\"2\" survives decode)", p.Deps[1].Lag)
	}
	if p.Deps[2].Pred != ganGateRef {
		t.Errorf("third dep Pred = %q, want the milestone %q (a milestone predecessor is the diff's DEP_FROM_MILESTONE)", p.Deps[2].Pred, ganGateRef)
	}
}

// TestGanDecode_RealGanttProjectFile decodes a genuine GanttProject 3.3.3316
// save. It replaces the parked "open basic.gan in GanttProject and save it
// unchanged" step: the app is not installed here, so this file is the only real
// GanttProject output the decoder can be checked against. It says nothing about
// what GanttProject does to a file EERP exported.
func TestGanDecode_RealGanttProjectFile(t *testing.T) {
	p, warnings := ganDecodeFile(t, "real_ganttproject_3.3.gan")

	if len(warnings) != 0 {
		t.Errorf("warnings = %+v, want none (no holidays in this file)", warnings)
	}
	if p.Name != "Untitled Gantt Project" {
		t.Errorf("Name = %q", p.Name)
	}
	if p.Weekend != DefaultWeekend {
		t.Errorf("Weekend = %v, want DefaultWeekend", p.Weekend)
	}
	if p.HasHolidays {
		t.Error("HasHolidays = true, want false")
	}
	if len(p.Tasks) != 28 {
		t.Fatalf("%d tasks, want 28", len(p.Tasks))
	}

	milestones := 0
	for _, task := range p.Tasks {
		if task.Milestone {
			milestones++
			if task.Duration != 0 {
				t.Errorf("milestone %q: Duration = %d, want 0", task.Name, task.Duration)
			}
			if !strings.HasPrefix(task.Key(), "new-milestone:") {
				t.Errorf("milestone %q: Key = %q, want a new-milestone key", task.Name, task.Key())
			}
		}
		// The file is flat, and GanttProject's own uid must not be read as ours.
		if task.Parent != "" {
			t.Errorf("task %q: Parent = %q, want flat", task.Name, task.Parent)
		}
		if task.HasChildren {
			t.Errorf("task %q: HasChildren = true, want false", task.Name)
		}
		if task.Ref != "" {
			t.Errorf("task %q: Ref = %q, want empty (no eerp_id column in a foreign file)", task.Name, task.Ref)
		}
		// The ten default taskproperties GanttProject lists must not be mistaken
		// for our planned_hours column.
		if task.PlannedHours != 0 {
			t.Errorf("task %q: PlannedHours = %v, want 0", task.Name, task.PlannedHours)
		}
	}
	if milestones != 5 {
		t.Errorf("%d milestones, want 5", milestones)
	}
	// Decoding normalises to the order the encoder writes: tasks, then milestones.
	for i := 28 - milestones; i < 28; i++ {
		if !p.Tasks[i].Milestone {
			t.Errorf("task %d (%q) is not a milestone, want milestones hoisted last", i, p.Tasks[i].Name)
		}
	}

	// A CDATA note and an & in a name: the note is ignored, the name survives.
	if got := ganTask(t, p, "new:5").Name; got != "3.2 Land evaluations & negotiations" {
		t.Errorf("task 5 name = %q, want the escaped name decoded", got)
	}

	if len(p.Deps) != 36 {
		t.Fatalf("%d deps, want 36 (every <depend> in the file resolves)", len(p.Deps))
	}
	// A milestone as predecessor: EERP cannot hold it, the diff warns and skips.
	for _, succ := range []string{"new:1", "new:4", "new:7"} {
		if !hasGanDep(p, PlanDep{Pred: "new-milestone:22", Succ: succ, Type: DepFS}) {
			t.Errorf("no dependency PMP ready -> %s, want the milestone-as-predecessor dep decoded", succ)
		}
	}
	// A real lag: 50 days, and 5, both from a milestone.
	if !hasGanDep(p, PlanDep{Pred: "new-milestone:25", Succ: "new:18", Type: DepFS, Lag: 50}) {
		t.Error(`no difference="50" dependency Contracts signed! -> Layout work`)
	}
	if !hasGanDep(p, PlanDep{Pred: "new-milestone:25", Succ: "new:14", Type: DepFS, Lag: 5}) {
		t.Error(`no difference="5" dependency Contracts signed! -> Construction work follow-up`)
	}
	for _, dep := range p.Deps {
		if dep.Pred == dep.Succ {
			t.Errorf("dependency %+v points at itself", dep)
		}
	}

	if len(p.Assignments) != 0 {
		t.Errorf("Assignments = %+v, want none (the file has no resources)", p.Assignments)
	}
}

func hasGanDep(p Plan, want PlanDep) bool {
	for _, dep := range p.Deps {
		if dep == want {
			return true
		}
	}
	return false
}

// TestGanRoundTrip checks that what the encoder writes is what the decoder reads
// back, for a plan carrying every field the format can express. FileIDs are the
// encoder's own numbering, so they are not compared.
func TestGanRoundTrip(t *testing.T) {
	p := Plan{
		Name:    "Round & trip <Project>",
		Weekend: Weekend{time.Wednesday: true, time.Saturday: true, time.Sunday: true},
		Tasks: []PlanTask{
			{Ref: ganRoundA, Name: `Parent "quoted" & <child>`, Start: exchangeDay(2026, time.January, 5),
				Duration: 10, PlannedHours: 40, Complete: 0, HasChildren: true},
			{Ref: ganRoundB, Name: "Child", Parent: ganRoundA, Start: exchangeDay(2026, time.January, 7),
				Duration: 5, PlannedHours: 16.5, Complete: 100},
			{Ref: ganRoundC, Name: "Sibling", Start: exchangeDay(2026, time.February, 2),
				Duration: 3, PlannedHours: 0.25, Complete: 0},
			{Ref: ganRoundGate, Name: "Gate", Milestone: true, Start: exchangeDay(2026, time.February, 20),
				Duration: 0, PlannedHours: 0, Complete: 0},
		},
		// A <depend> hangs off its predecessor, so the format cannot keep
		// dependencies in an order other than their predecessors' document order:
		// that is the order this plan lists them in, and what a decoded file comes
		// back in. Plan.Deps itself promises nothing about order (see its comment),
		// which is why a diff has to compare them as a multiset.
		Deps: []PlanDep{
			{Pred: ganRoundA, Succ: ganRoundC, Type: DepFF, Lag: 1},
			{Pred: ganRoundA, Succ: ganRoundGate, Type: DepSF, Lag: 3},
			{Pred: ganRoundB, Succ: ganRoundC, Type: DepFS, Lag: 2},
			{Pred: ganRoundC, Succ: ganRoundGate, Type: DepSS, Lag: 0},
		},
		Assignments: []PlanAssign{
			{Task: ganRoundB, Email: "ann@x.com", Name: "Ann Lee"},
			{Task: ganRoundC, Email: "bob@x.com", Name: "Bob"},
			{Task: ganRoundGate, Email: "ann@x.com", Name: "Ann Lee"},
		},
	}

	var buf bytes.Buffer
	if err := (ganFormat{}).Encode(&buf, p); err != nil {
		t.Fatalf("Encode: %v", err)
	}
	got, warnings, err := ganFormat{}.Decode(bytes.NewReader(buf.Bytes()))
	if err != nil {
		t.Fatalf("Decode(Encode(p)): %v\n%s", err, buf.String())
	}
	if len(warnings) != 0 {
		t.Errorf("warnings = %+v, want none", warnings)
	}

	// The format carries no holidays and no undated flag: the plan it writes back
	// is the plan it reads, on the fields it can hold.
	want := p
	want.HasHolidays = false
	for i := range want.Tasks {
		want.Tasks[i].FileID = ""
		want.Tasks[i].Undated = false
	}
	gotTasks := make([]PlanTask, len(got.Tasks))
	copy(gotTasks, got.Tasks)
	for i := range gotTasks {
		gotTasks[i].FileID = ""
	}
	got.Tasks = gotTasks

	if !reflect.DeepEqual(got, want) {
		t.Errorf("Decode(Encode(p)) != p\n got: %+v\nwant: %+v\ndiff:\n%s", got, want, ganTaskDiff(want.Tasks, got.Tasks))
	}
}

func ganTaskDiff(want, got []PlanTask) string {
	var b strings.Builder
	for i := range want {
		if i >= len(got) {
			fmt.Fprintf(&b, "task %d missing: %+v\n", i, want[i])
			continue
		}
		if want[i] != got[i] {
			fmt.Fprintf(&b, "task %d:\n  got  %+v\n  want %+v\n", i, got[i], want[i])
		}
	}
	return b.String()
}

func TestGanDecode_Malformed(t *testing.T) {
	// A billion laughs: Go's encoding/xml never expands a declared entity, so the
	// file has to come back as an error rather than as an expanded name.
	bomb := `<?xml version="1.0"?>
<!DOCTYPE project [
  <!ENTITY x "01234567890123456789012345678901234567890123456789">
]>
<project name="` + strings.Repeat("&x;", 40) + `"><tasks/></project>`

	cases := []struct {
		name string
		doc  string
	}{
		{"truncated", `<?xml version="1.0" encoding="UTF-8"?><project name="x"><tasks><task id="1"><depend id="2"/>`},
		{"truncated mid attribute", `<project name="x" duration="`},
		{"billion laughs", bomb},
		{"external entity", `<?xml version="1.0"?><!DOCTYPE project [<!ENTITY x SYSTEM "file:///etc/passwd">]><project name="&x;"/>`},
		{"not a project root", `<html><body><p>x</p></body></html>`},
		{"mspdi root", `<Project><Tasks><Task><Name>x</Name></Task></Tasks></Project>`},
		{"not xml at all", `PK`},
		{"empty", ``},
		{"unclosed element", `<project name="x"><tasks></project>`},
		{"mismatched quote", `<project name="x/>`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p, warnings, err := ganDecodeString(t, tc.doc)
			if err == nil {
				t.Fatalf("Decode returned no error for %s; plan %+v warnings %+v", tc.name, p, warnings)
			}
			if len(warnings) != 0 {
				t.Errorf("warnings = %+v, want none alongside an error", warnings)
			}
			if !reflect.DeepEqual(p, Plan{}) {
				t.Errorf("plan = %+v, want the zero Plan alongside an error", p)
			}
		})
	}
}

// TestGanDecode_TooManyTasks is the file-side ceiling: the import's 5000 task
// cap is checked while decoding, so a hostile upload comes back as an error
// rather than as a plan nobody can apply.
func TestGanDecode_TooManyTasks(t *testing.T) {
	build := func(n int) string {
		var b strings.Builder
		b.WriteString(`<project name="big"><tasks>`)
		for i := 1; i <= n; i++ {
			fmt.Fprintf(&b, `<task id="%d" name="t%d" meeting="false" start="2026-01-05" duration="5" complete="0"/>`, i, i)
		}
		b.WriteString(`</tasks></project>`)
		return b.String()
	}

	if _, _, err := ganDecodeString(t, build(ganMaxTasks)); err != nil {
		t.Errorf("Decode of %d tasks: %v, want no error at the cap", ganMaxTasks, err)
	}
	if _, _, err := ganDecodeString(t, build(ganMaxTasks+1)); err == nil {
		t.Errorf("Decode of %d tasks: no error, want one over the cap", ganMaxTasks+1)
	}
}

// TestGanDecode_Hostile checks the shapes that must not panic, hang, or invent
// data: deep nesting, a huge duration, garbage numbers.
func TestGanDecode_Hostile(t *testing.T) {
	t.Run("deep nesting is refused, not crashed", func(t *testing.T) {
		const depth = 100000
		doc := `<project name="deep"><tasks>` +
			strings.Repeat(`<task id="1">`, depth) + strings.Repeat(`</task>`, depth) +
			`</tasks></project>`
		if _, _, err := ganDecodeString(t, doc); err == nil {
			t.Error("no error for 100000 levels of nesting, want one")
		}
	})

	t.Run("a huge duration is clamped", func(t *testing.T) {
		doc := `<project name="c"><tasks><task id="1" name="x" meeting="false" start="2026-01-05" duration="999999999" complete="0"/></tasks></project>`
		p, _, err := ganDecodeString(t, doc)
		if err != nil {
			t.Fatalf("Decode: %v", err)
		}
		if p.Tasks[0].Duration != ganMaxDurationDays {
			t.Errorf("Duration = %d, want it clamped to %d so the day loop stays short",
				p.Tasks[0].Duration, ganMaxDurationDays)
		}
	})

	t.Run("garbage numbers do not invent data", func(t *testing.T) {
		doc := `<project name="c"><tasks>` +
			`<task id="1" name="x" meeting="false" start="not a day" duration="abc" complete="700"/>` +
			`<task id="2" name="y" meeting="false"/>` +
			`</tasks></project>`
		p, _, err := ganDecodeString(t, doc)
		if err != nil {
			t.Fatalf("Decode: %v", err)
		}
		if !p.Tasks[0].Start.IsZero() {
			t.Errorf("Start = %v, want the zero day for an unparsable date", p.Tasks[0].Start)
		}
		if p.Tasks[0].Duration != 0 || p.Tasks[0].Complete != 100 {
			t.Errorf("garbage duration/complete = %d/%d, want 0/100 (clamped into range)",
				p.Tasks[0].Duration, p.Tasks[0].Complete)
		}
		if !p.Tasks[1].Start.IsZero() || p.Tasks[1].Duration != 0 {
			t.Errorf("task with no dates at all = %v/%d, want the zero day and 0", p.Tasks[1].Start, p.Tasks[1].Duration)
		}
	})

	t.Run("every attribute missing but the id", func(t *testing.T) {
		p, warnings, err := ganDecodeString(t, `<project><tasks><task id="1"/></tasks></project>`)
		if err != nil {
			t.Fatalf("Decode: %v", err)
		}
		if len(p.Tasks) != 1 || p.Tasks[0].Key() != "new:1" {
			t.Errorf("tasks = %+v, want one task keyed new:1", p.Tasks)
		}
		if p.Tasks[0].FileID != "1" {
			t.Errorf("FileID = %q, want the file's own id, which is what names the row", p.Tasks[0].FileID)
		}
		if len(warnings) != 0 {
			t.Errorf("warnings = %+v, want none", warnings)
		}
	})

	t.Run("a task with no id is refused", func(t *testing.T) {
		// A row the file does not number cannot be named by Parent, PlanDep or
		// PlanAssign, and two of them would share the key "new:", so one would be
		// silently lost. GanttProject always numbers its rows.
		for _, doc := range []string{
			`<project><tasks><task/></tasks></project>`,
			`<project><tasks><task name="no id" meeting="false" start="2026-01-05" duration="1"/></tasks></project>`,
			`<project><tasks><task id="1" name="parent"><task name="orphan"/></task></tasks></project>`,
		} {
			p, warnings, err := ganDecodeString(t, doc)
			if err == nil {
				t.Errorf("Decode(%s) = no error, want one; plan %+v", doc, p)
				continue
			}
			if !errors.Is(err, errNotGan) {
				t.Errorf("Decode(%s) error = %v, want it to wrap errNotGan (422 INVALID_FILE)", doc, err)
			}
			if len(warnings) != 0 || !reflect.DeepEqual(p, Plan{}) {
				t.Errorf("Decode(%s) = plan %+v warnings %+v, want the zero plan and none", doc, p, warnings)
			}
		}
	})
}

// TestGanDecode_Shape covers the shape decisions the real GanttProject file
// forced: ignorable extras, both holiday placements, renamed columns, and the
// references a partner can break.
func TestGanDecode_Shape(t *testing.T) {
	t.Run("unknown elements and CDATA are ignored", func(t *testing.T) {
		doc := `<project name="x" version="9.9" locale="fr_FR" company="acme">
		  <view id="gantt-chart"><field id="tpd3" name="Nom" width="209"/><option id="color.recent"><![CDATA[#ff6666]]></option></view>
		  <calendars><day-types><day-type id="0"/><default-week sun="1" mon="0" tue="0" wed="0" thu="0" fri="0" sat="1"/>
		    <only-show-weekends value="false"/><overriden-day-types/><days/></day-types></calendars>
		  <tasks empty-milestones="true"><task id="1" name="x" uid="aa8601af38994a3681696685d3948c84" meeting="false" start="2026-01-05" duration="2" complete="0" expand="true">
		    <notes><![CDATA[On a tout ce qu'il faut <b>vraiment</b>]]></notes><view/><description/>
		  </task></tasks><vacations/><previous/><roles roleset-name="Default"/></project>`
		p, warnings, err := ganDecodeString(t, doc)
		if err != nil {
			t.Fatalf("Decode: %v", err)
		}
		if len(p.Tasks) != 1 || p.Tasks[0].Name != "x" || p.Tasks[0].Ref != "" {
			t.Errorf("tasks = %+v, want the one task with no eerp_id (uid is not ours)", p.Tasks)
		}
		if len(warnings) != 0 {
			t.Errorf("warnings = %+v, want none", warnings)
		}
		if p.Name != "x" {
			t.Errorf("Name = %q, want x", p.Name)
		}
	})

	t.Run("holidays under day-types count too", func(t *testing.T) {
		doc := `<project name="x"><calendars><day-types><default-week sun="1" mon="0" tue="0" wed="0" thu="0" fri="0" sat="1"/>` +
			`<date year="2026" month="12" date="25" type="HOLIDAY"/></day-types></calendars><tasks/></project>`
		p, warnings, err := ganDecodeString(t, doc)
		if err != nil {
			t.Fatalf("Decode: %v", err)
		}
		if !p.HasHolidays {
			t.Error("HasHolidays = false, want true for a <date> inside day-types")
		}
		if len(warnings) != 1 || warnings[0].Code != "HOLIDAYS" {
			t.Errorf("warnings = %+v, want one HOLIDAYS", warnings)
		}
	})

	t.Run("a date that is not a holiday is not a holiday", func(t *testing.T) {
		doc := `<project name="x"><calendars><day-types><default-week sun="1" mon="0" tue="0" wed="0" thu="0" fri="0" sat="1"/></day-types>` +
			`<date year="2026" month="5" date="9" type="NEWORKINGDAY"/></calendars><tasks/></project>`
		p, warnings, err := ganDecodeString(t, doc)
		if err != nil {
			t.Fatalf("Decode: %v", err)
		}
		if p.HasHolidays || len(warnings) != 0 {
			t.Errorf("HasHolidays = %v, warnings = %+v, want false and none for a NEWORKINGDAY", p.HasHolidays, warnings)
		}
	})

	t.Run("no calendar is the default weekend", func(t *testing.T) {
		p, _, err := ganDecodeString(t, `<project name="x"><tasks/></project>`)
		if err != nil {
			t.Fatalf("Decode: %v", err)
		}
		if p.Weekend != DefaultWeekend {
			t.Errorf("Weekend = %v, want DefaultWeekend", p.Weekend)
		}
	})

	t.Run("a custom property of an unknown column is ignored", func(t *testing.T) {
		doc := `<project name="x"><tasks><taskproperties>` +
			`<taskproperty id="tpd0" name="priority" type="default" valuetype="icon"/>` +
			`</taskproperties>` +
			`<task id="1" name="x" meeting="false" start="2026-01-05" duration="1" complete="0">` +
			`<customproperty taskproperty-id="tpd0" value="1"/>` +
			`<customproperty taskproperty-id="gone" value="deadbeef"/>` +
			`<customproperty taskproperty-id="tpd0" value="1"/></task></tasks></project>`
		p, _, err := ganDecodeString(t, doc)
		if err != nil {
			t.Fatalf("Decode: %v", err)
		}
		if p.Tasks[0].Ref != "" || p.Tasks[0].PlannedHours != 0 {
			t.Errorf("task = %+v, want no ref and no hours from foreign columns", p.Tasks[0])
		}
	})

	t.Run("hours that are not a number", func(t *testing.T) {
		doc := `<project name="x"><tasks><taskproperties>` +
			`<taskproperty id="tpc1" name="planned_hours" type="custom" valuetype="double"/>` +
			`</taskproperties><task id="1" name="x" meeting="false" start="2026-01-05" duration="1" complete="0">` +
			`<customproperty taskproperty-id="tpc1" value="twelve"/></task></tasks></project>`
		p, _, err := ganDecodeString(t, doc)
		if err != nil {
			t.Fatalf("Decode: %v", err)
		}
		if p.Tasks[0].PlannedHours != 0 {
			t.Errorf("PlannedHours = %v, want 0 for a value that is not a number", p.Tasks[0].PlannedHours)
		}
	})

	t.Run("a dependency to a task that is not there is dropped", func(t *testing.T) {
		doc := `<project name="x"><tasks>` +
			`<task id="1" name="x" meeting="false" start="2026-01-05" duration="1" complete="0">` +
			`<depend id="404" type="2" difference="0" hardness="Strong"/>` +
			`<depend id="1" type="2" difference="0" hardness="Strong"/></task></tasks></project>`
		p, _, err := ganDecodeString(t, doc)
		if err != nil {
			t.Fatalf("Decode: %v", err)
		}
		if len(p.Deps) != 1 || p.Deps[0].Succ != "new:1" {
			t.Errorf("deps = %+v, want only the resolvable one", p.Deps)
		}
	})

	t.Run("an unknown dependency type reads as finish to start", func(t *testing.T) {
		doc := `<project name="x"><tasks>` +
			`<task id="1" name="x" meeting="false" start="2026-01-05" duration="1" complete="0"><depend id="2" type="9" difference="0"/></task>` +
			`<task id="2" name="y" meeting="false" start="2026-01-06" duration="1" complete="0"/></tasks></project>`
		p, _, err := ganDecodeString(t, doc)
		if err != nil {
			t.Fatalf("Decode: %v", err)
		}
		if len(p.Deps) != 1 || p.Deps[0].Type != DepFS {
			t.Errorf("deps = %+v, want one finish to start", p.Deps)
		}
	})

	t.Run("allocations of nothing are dropped, and a double allocation counts once", func(t *testing.T) {
		doc := `<project name="x"><tasks>` +
			`<task id="1" name="x" meeting="false" start="2026-01-05" duration="1" complete="0"/>` +
			`</tasks><resources>` +
			`<resource id="1" name="Ann Lee" contacts="ann@x.com"/>` +
			`</resources><allocations>` +
			`<allocation task-id="404" resource-id="1"/>` +
			`<allocation task-id="1" resource-id="404"/>` +
			`<allocation task-id="1" resource-id="1"/>` +
			`<allocation task-id="1" resource-id="1"/>` +
			`</allocations></project>`
		p, _, err := ganDecodeString(t, doc)
		if err != nil {
			t.Fatalf("Decode: %v", err)
		}
		if len(p.Assignments) != 1 {
			t.Fatalf("assignments = %+v, want the one resolvable allocation", p.Assignments)
		}
		if p.Assignments[0] != (PlanAssign{Task: "new:1", Email: "ann@x.com", Name: "Ann Lee"}) {
			t.Errorf("assignment = %+v", p.Assignments[0])
		}
	})

	t.Run("a milestone nested under a task is read at the top level", func(t *testing.T) {
		doc := `<project name="x"><tasks>` +
			`<task id="1" name="Parent" meeting="false" start="2026-01-05" duration="2" complete="0">` +
			`<task id="2" name="Gate" meeting="true" start="2026-01-07" duration="0" complete="0"/>` +
			`</task></tasks></project>`
		p, warnings, err := ganDecodeString(t, doc)
		if err != nil {
			t.Fatalf("Decode: %v", err)
		}
		if len(p.Tasks) != 2 {
			t.Fatalf("tasks = %+v, want the parent then the milestone", p.Tasks)
		}
		if !p.Tasks[0].HasChildren {
			t.Error("Parent: HasChildren = false, want true")
		}
		if !p.Tasks[1].Milestone || p.Tasks[1].Parent != "" {
			t.Errorf("milestone = %+v, want Milestone true at the top level", p.Tasks[1])
		}
		// EERP's own WBS shows a milestone under a task, so this is not a warning.
		if len(warnings) != 0 {
			t.Errorf("warnings = %+v, want none", warnings)
		}
	})
}

// TestGanDecode_RefShape pins the identity boundary. The only eerp_id the decoder
// hands to the model is one EERP could itself have written (see validRef): a task
// uuid, or milestone: plus a uuid. Anything else is read the way a foreign id is
// already read, as a row the file added keyed on its own file id, and says so with
// the same UNKNOWN_ID warning the diff raises for an id this project does not know.
//
// The shape that matters is new:7. Key() builds a new row's key from its file id,
// so a file allowed to put that in eerp_id would be handed the key of another row,
// and that row would vanish from the diff without a word: no duplicate warning, no
// change row.
func TestGanDecode_RefShape(t *testing.T) {
	row := func(value string) string {
		return `<project name="x"><tasks>` +
			`<taskproperties>` +
			`<taskproperty id="tpc0" name="eerp_id" type="custom" valuetype="text"/>` +
			`</taskproperties>` +
			`<task id="7" name="Row" meeting="false" start="2026-01-05" duration="1" complete="0">` +
			`<customproperty taskproperty-id="tpc0" value="` + value + `"/></task></tasks></project>`
	}

	t.Run("an EERP id survives", func(t *testing.T) {
		// The padded pair is the same identity read through the same trimming the
		// planned_hours column gets: a stray space is not another row.
		for _, tc := range []struct{ value, want string }{
			{ganAlphaRef, ganAlphaRef},
			{ganGateRef, ganGateRef},
			{" " + ganAlphaRef, ganAlphaRef},
			{ganAlphaRef + "\t", ganAlphaRef},
		} {
			p, warnings, err := ganDecodeString(t, row(tc.value))
			if err != nil {
				t.Fatalf("Decode(%q): %v", tc.value, err)
			}
			if len(p.Tasks) != 1 || p.Tasks[0].Ref != tc.want {
				t.Errorf("Decode(%q): tasks = %+v, want the one row carrying %q", tc.value, p.Tasks, tc.want)
			}
			if len(warnings) != 0 {
				t.Errorf("Decode(%q): warnings = %+v, want none for an id EERP can hold", tc.value, warnings)
			}
		}
	})

	t.Run("an id is read in one spelling", func(t *testing.T) {
		// A UUID is case-insensitive, and the loader writes the ids Postgres
		// spells in lower-case. A partner who hand-edits the XML (or a tool that
		// upper-cases them) means the same task either way, so the decoder hands
		// the diff one spelling: the canonical one. Without this, the second
		// spelling names nothing here and the task comes back as a duplicate of
		// itself. Only the id is case-insensitive: an upper-case milestone: prefix
		// is not an EERP id at all (see the case below), so it stays refused.
		for _, tc := range []struct{ value, want string }{
			{strings.ToUpper(ganAlphaRef), ganAlphaRef},
			{"AAAAAAAA-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ganAlphaRef},
			{"milestone:DDDDDDDD-DDDD-4DDD-8DDD-DDDDDDDDDDDD", ganGateRef},
			{" milestone:EEEEEEEE-0000-4000-8000-000000000004 ", ganRoundGate},
			// Mixed case in the middle of the id, the shape a hand-edit takes.
			{"eeeeeeee-0000-4000-8000-00000000000A", "eeeeeeee-0000-4000-8000-00000000000a"},
		} {
			p, warnings, err := ganDecodeString(t, row(tc.value))
			if err != nil {
				t.Fatalf("Decode(%q): %v", tc.value, err)
			}
			if len(p.Tasks) != 1 || p.Tasks[0].Ref != tc.want {
				t.Errorf("Decode(%q): tasks = %+v, want the one row carrying %q", tc.value, p.Tasks, tc.want)
			}
			if len(warnings) != 0 {
				t.Errorf("Decode(%q): warnings = %+v, want none for an id EERP can hold", tc.value, warnings)
			}
		}
	})

	t.Run("any other shape is an unknown id", func(t *testing.T) {
		bad := []string{
			// The synthetic namespace of Key(), which a file must never reach.
			"new:7", "new-milestone:7", "new:", "new", "new-milestone:",
			// Not an id at all.
			"7", "not-a-uuid", "00000000-0000-0000-0000-00000000000g",
			"milestone:", "milestone:not-a-uuid", "milestone:m",
			"MILESTONE:" + ganAlphaRef, "milestone:" + ganAlphaRef + "f",
			"aaaa-bbbb", ganAlphaRef[:len(ganAlphaRef)-1],
			strings.Repeat("a", 36), ganAlphaRef + "," + ganRoundB,
		}
		for _, value := range bad {
			p, warnings, err := ganDecodeString(t, row(value))
			if err != nil {
				t.Errorf("Decode(%q): %v, want the file to decode with the row read as new", value, err)
				continue
			}
			if len(p.Tasks) != 1 {
				t.Fatalf("Decode(%q) = %+v, want one row", value, p.Tasks)
			}
			task := p.Tasks[0]
			if task.Ref != "" {
				t.Errorf("Decode(%q): Ref = %q, want it dropped: the row is a create", value, task.Ref)
			}
			if task.FileID != "7" || task.Key() != "new:7" {
				t.Errorf("Decode(%q): FileID/Key = %q/%q, want 7/new:7 (keyed on its own file id)",
					value, task.FileID, task.Key())
			}
			if len(warnings) != 1 || warnings[0].Code != "UNKNOWN_ID" || warnings[0].Task != "Row" {
				t.Errorf("Decode(%q): warnings = %+v, want one UNKNOWN_ID naming the task", value, warnings)
			}
		}
	})

	t.Run("an empty or absent eerp_id is an ordinary create", func(t *testing.T) {
		// The partner's own task: GanttProject writes the column with an empty
		// value, which is not a broken id and must not warn.
		for _, doc := range []string{row(""), row(strings.Repeat(" ", 3))} {
			p, warnings, err := ganDecodeString(t, doc)
			if err != nil {
				t.Fatalf("Decode: %v", err)
			}
			if len(p.Tasks) != 1 || p.Tasks[0].Key() != "new:7" {
				t.Errorf("tasks = %+v, want one row keyed new:7", p.Tasks)
			}
			if len(warnings) != 0 {
				t.Errorf("warnings = %+v, want none for a row nobody gave an id", warnings)
			}
		}
	})

	t.Run("a milestone keeps a well formed prefixed id", func(t *testing.T) {
		doc := `<project name="x"><tasks>` +
			`<taskproperties>` +
			`<taskproperty id="tpc0" name="eerp_id" type="custom" valuetype="text"/>` +
			`</taskproperties>` +
			`<task id="9" name="Gate" meeting="true" start="2026-01-05" duration="0" complete="0">` +
			`<customproperty taskproperty-id="tpc0" value="` + ganGateRef + `"/></task></tasks></project>`
		p, warnings, err := ganDecodeString(t, doc)
		if err != nil {
			t.Fatalf("Decode: %v", err)
		}
		if len(p.Tasks) != 1 || p.Tasks[0].Ref != ganGateRef || !p.Tasks[0].Milestone {
			t.Errorf("tasks = %+v, want the milestone carrying its prefixed id", p.Tasks)
		}
		if len(warnings) != 0 {
			t.Errorf("warnings = %+v, want none", warnings)
		}
	})

	t.Run("a forged new: id cannot take another row's key", func(t *testing.T) {
		// The collision the boundary exists for: the row the file added as id 7 is
		// the one a hand-written eerp_id="new:7" claims to be, and the dependency
		// and the allocation both name it. Read verbatim, the two rows collapsed
		// onto one Key and a whole task disappeared from the diff in silence.
		doc := `<project name="x"><tasks>` +
			`<taskproperties>` +
			`<taskproperty id="tpc0" name="eerp_id" type="custom" valuetype="text"/>` +
			`</taskproperties>` +
			`<task id="1" name="Forged" meeting="false" start="2026-01-05" duration="1" complete="0">` +
			`<customproperty taskproperty-id="tpc0" value="new:7"/>` +
			`<depend id="7" type="2" difference="0" hardness="Strong"/></task>` +
			`<task id="7" name="Genuine" meeting="false" start="2026-01-06" duration="1" complete="0"/>` +
			`</tasks><resources>` +
			`<resource id="1" name="Ann Lee" contacts="ann@x.com"/>` +
			`</resources><allocations>` +
			`<allocation task-id="7" resource-id="1"/>` +
			`</allocations></project>`
		p, warnings, err := ganDecodeString(t, doc)
		if err != nil {
			t.Fatalf("Decode: %v", err)
		}
		if len(p.Tasks) != 2 {
			t.Fatalf("%d tasks = %+v, want both rows: a file must not be able to hide one", len(p.Tasks), p.Tasks)
		}
		forged := ganTask(t, p, "new:1")
		if forged.Name != "Forged" || forged.Ref != "" {
			t.Errorf("forged row = %+v, want it read as a new row with no Ref", forged)
		}
		genuine := ganTask(t, p, "new:7")
		if genuine.Name != "Genuine" {
			t.Errorf("row keyed new:7 = %+v, want the row the file added as id 7", genuine)
		}
		wantDeps := []PlanDep{{Pred: "new:1", Succ: "new:7", Type: DepFS, Lag: 0}}
		if !reflect.DeepEqual(p.Deps, wantDeps) {
			t.Errorf("deps = %+v, want %+v (the dependency still names the row it pointed at)", p.Deps, wantDeps)
		}
		wantAssigns := []PlanAssign{{Task: "new:7", Email: "ann@x.com", Name: "Ann Lee"}}
		if !reflect.DeepEqual(p.Assignments, wantAssigns) {
			t.Errorf("assignments = %+v, want %+v", p.Assignments, wantAssigns)
		}
		if len(warnings) != 1 || warnings[0].Code != "UNKNOWN_ID" || warnings[0].Task != "Forged" {
			t.Errorf("warnings = %+v, want exactly one UNKNOWN_ID naming the forged row", warnings)
		}
	})

	t.Run("two rows of one file id never share a key", func(t *testing.T) {
		// FileIDs are what a new row keys on, so the decoder never hands out a row
		// without one (see the missing id case in TestGanDecode_Hostile); this is
		// the same promise from the other side, with the milestone prefix involved.
		doc := `<project name="x"><tasks>` +
			`<taskproperties>` +
			`<taskproperty id="tpc0" name="eerp_id" type="custom" valuetype="text"/>` +
			`</taskproperties>` +
			`<task id="3" name="Gate" meeting="true" start="2026-01-05" duration="0" complete="0">` +
			`<customproperty taskproperty-id="tpc0" value="new-milestone:4"/></task>` +
			`<task id="4" name="Other gate" meeting="true" start="2026-01-06" duration="0" complete="0"/>` +
			`</tasks></project>`
		p, warnings, err := ganDecodeString(t, doc)
		if err != nil {
			t.Fatalf("Decode: %v", err)
		}
		if len(p.Tasks) != 2 || p.Tasks[0].Key() != "new-milestone:3" || p.Tasks[1].Key() != "new-milestone:4" {
			t.Errorf("tasks = %+v, want the two milestones on their own file ids", p.Tasks)
		}
		if len(warnings) != 1 || warnings[0].Code != "UNKNOWN_ID" {
			t.Errorf("warnings = %+v, want one UNKNOWN_ID", warnings)
		}
	})
}

// TestGanDecode_Calendar pins what the decoder makes of the file's <default-week>,
// and above all the mask that works no day. <default-week sun="1" ... sat="1"/>
// states a calendar with no working day at all: a file like that holds no schedule
// (any duration at all looks for a worked day that never comes), and GanttProject
// never writes one. It comes back as "not this format", which the route answers 422
// INVALID_FILE, rather than as a plan whose calendar EERP invented. The day loops
// are bounded on their own whatever the mask says (see TestWorkdays), so this is
// the layer above them refusing a file no calendar can schedule, not the guard
// against a hang.
func TestGanDecode_Calendar(t *testing.T) {
	week := func(attrs string) string {
		return `<project name="x"><calendars><day-types><day-type id="0"/><default-week id="1" name="default" ` +
			attrs + `/></day-types></calendars>` +
			`<tasks><task id="1" name="x" meeting="false" start="2026-01-05" duration="2" complete="0"/></tasks></project>`
	}

	t.Run("a week that works no day is refused", func(t *testing.T) {
		for _, attrs := range []string{
			`sun="1" mon="1" tue="1" wed="1" thu="1" fri="1" sat="1"`,
			`sun="true" mon="true" tue="true" wed="true" thu="true" fri="true" sat="true"`,
			`sun="1" mon="TRUE" tue="1" wed="True" thu="1" fri="1" sat="1"`,
		} {
			p, warnings, err := ganDecodeString(t, week(attrs))
			if err == nil {
				t.Errorf("Decode(%s) = no error, want a refusal; plan %+v", attrs, p)
				continue
			}
			if !errors.Is(err, errNotGan) {
				t.Errorf("Decode(%s) error = %v, want it to wrap errNotGan (422 INVALID_FILE)", attrs, err)
			}
			if len(warnings) != 0 || !reflect.DeepEqual(p, Plan{}) {
				t.Errorf("Decode(%s) = plan %+v warnings %+v, want the zero plan and none", attrs, p, warnings)
			}
		}
	})

	t.Run("a week with one worked day is a calendar", func(t *testing.T) {
		// The sparsest real calendar: seven days walked per worked day. Read, not
		// refused, and the plan carries it whole.
		p, warnings, err := ganDecodeString(t, week(`sun="1" mon="0" tue="1" wed="1" thu="1" fri="1" sat="1"`))
		if err != nil {
			t.Fatalf("Decode: %v", err)
		}
		if p.Weekend != worksOnly(time.Monday) {
			t.Errorf("Weekend = %v, want Monday worked and nothing else", p.Weekend)
		}
		if !p.Weekend.hasWorkedDay() {
			t.Error("hasWorkedDay() = false, want true: the decoder never hands out a mask with none")
		}
		if len(warnings) != 0 {
			t.Errorf("warnings = %+v, want none", warnings)
		}
	})

	t.Run("a week that works every day is read as it says", func(t *testing.T) {
		// The other all-one-value mask, and the legal one: every day worked is a
		// calendar GanttProject writes (the six day week a partner really runs).
		p, warnings, err := ganDecodeString(t, week(`sun="0" mon="0" tue="0" wed="0" thu="0" fri="0" sat="0"`))
		if err != nil {
			t.Fatalf("Decode: %v", err)
		}
		if p.Weekend != (Weekend{}) {
			t.Errorf("Weekend = %v, want every day worked as the file states", p.Weekend)
		}
		if len(warnings) != 0 {
			t.Errorf("warnings = %+v, want none", warnings)
		}
		// The decoder never substitutes a calendar for a file that gave one: the
		// default is what a file with no default-week gets, not this one.
		if p.Weekend == DefaultWeekend {
			t.Error("Weekend = DefaultWeekend, want the file's own mask")
		}
	})

	t.Run("a calendars block with no default-week keeps the default", func(t *testing.T) {
		doc := `<project name="x"><calendars><day-types><day-type id="0"/></day-types></calendars>` +
			`<tasks><task id="1" name="x" meeting="false" start="2026-01-05" duration="1" complete="0"/></tasks></project>`
		p, warnings, err := ganDecodeString(t, doc)
		if err != nil {
			t.Fatalf("Decode: %v", err)
		}
		if p.Weekend != DefaultWeekend {
			t.Errorf("Weekend = %v, want DefaultWeekend", p.Weekend)
		}
		if len(warnings) != 0 {
			t.Errorf("warnings = %+v, want none", warnings)
		}
	})
}

// TestGanEncode_Shape pins what the encoder writes: the numbering, the order, the
// two custom columns, and the weakest dependency hardness that keeps a pushed
// successor visible as a conflict.
func TestGanEncode_Shape(t *testing.T) {
	p := Plan{
		Name: `Q&A "Project" <2026>`,
		// The milestone is deliberately not last in Tasks: Plan promises it last in
		// the file, so the encoder has to move it there itself rather than trust
		// the caller's order.
		Tasks: []PlanTask{
			{Ref: ganRoundGate, Name: "Gate", Milestone: true, Start: exchangeDay(2026, time.January, 9)},
			{Ref: ganRoundA, Name: "Parent", Start: exchangeDay(2026, time.January, 5), Duration: 3, PlannedHours: 8, HasChildren: true},
			{Ref: ganRoundB, Name: "Child", Parent: ganRoundA, Start: exchangeDay(2026, time.January, 6), Duration: 2, Complete: 100},
		},
		Deps: []PlanDep{
			{Pred: ganRoundA, Succ: ganRoundB, Type: DepFS},
			{Pred: ganRoundB, Succ: ganRoundGate, Type: DepFS, Lag: 2},
			{Pred: ganRoundA, Succ: "gone", Type: DepFS},
		},
		Assignments: []PlanAssign{{Task: ganRoundB, Email: "ann@x.com", Name: "Ann Lee"}},
	}
	var buf bytes.Buffer
	if err := (ganFormat{}).Encode(&buf, p); err != nil {
		t.Fatalf("Encode: %v", err)
	}
	out := buf.String()

	// It has to be readable as XML by GanttProject.
	if err := xml.Unmarshal(buf.Bytes(), &struct{}{}); err != nil {
		t.Errorf("the encoder did not write well formed XML: %v\n%s", err, out)
	}

	for _, want := range []string{
		`<project name="Q&amp;A &#34;Project&#34; &lt;2026&gt;"`,
		`<taskproperty id="tpc0" name="eerp_id" type="custom" valuetype="text"`,
		`<taskproperty id="tpc1" name="planned_hours" type="custom" valuetype="double"`,
		`<customproperty taskproperty-id="tpc0" value="milestone:eeeeeeee-0000-4000-8000-000000000004"`,
		`hardness="Rubber"`,
		`difference="2"`,
		`<resource id="1" name="Ann Lee" function="Default:0" contacts="ann@x.com"`,
		`<allocation task-id="2" resource-id="1"`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("encoded file misses %s\n%s", want, out)
		}
	}
	// The dependency to a task that is not in the plan cannot be written.
	if strings.Contains(out, `id="gone"`) {
		t.Errorf("encoded file carries a dependency to an unknown task\n%s", out)
	}

	// Ids are 1..n in document order, milestones last, so task 3 is the milestone
	// and the depend inside task 2 points at it.
	for _, want := range []string{
		`<task id="1" name="Parent"`,
		`<task id="2" name="Child"`,
		`<task id="3" name="Gate"`,
		`<depend id="3" type="2" difference="2"`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("encoded file misses %s\n%s", want, out)
		}
	}
	if idx := strings.Index(out, `name="Gate"`); idx < strings.Index(out, `name="Child"`) {
		t.Error("the milestone is written before the tasks, want it last")
	}
}

// TestGanEncode_HostilePlan covers the plans that must not hang the encoder or
// lose a row: only a decoded file or the database reaches the encoder in
// practice, and neither produces these, but a bug here would be a hung request.
func TestGanEncode_HostilePlan(t *testing.T) {
	t.Run("a Parent cycle is cut and keeps its rows", func(t *testing.T) {
		p := Plan{Tasks: []PlanTask{
			{Ref: ganRoundA, Name: "X", Parent: ganRoundB, Start: exchangeDay(2026, time.January, 5), Duration: 1},
			{Ref: ganRoundB, Name: "Y", Parent: ganRoundA, Start: exchangeDay(2026, time.January, 6), Duration: 1},
		}}
		var buf bytes.Buffer
		done := make(chan error, 1)
		go func() { done <- (ganFormat{}).Encode(&buf, p) }()
		select {
		case err := <-done:
			if err != nil {
				t.Fatalf("Encode: %v", err)
			}
		case <-time.After(10 * time.Second):
			t.Fatal("Encode hung on a Plan whose Parent links form a cycle")
		}
		got, _, err := ganDecodeString(t, buf.String())
		if err != nil {
			t.Fatalf("Decode: %v\n%s", err, buf.String())
		}
		if len(got.Tasks) != 2 {
			t.Errorf("%d tasks written, want both rows of the cycle\n%s", len(got.Tasks), buf.String())
		}
	})

	t.Run("a duplicated Key still gives every row its own id", func(t *testing.T) {
		p := Plan{Tasks: []PlanTask{
			{Ref: ganRoundDupRef, Name: "First", Start: exchangeDay(2026, time.January, 5), Duration: 1},
			{Ref: ganRoundDupRef, Name: "Second", Start: exchangeDay(2026, time.January, 6), Duration: 1},
		}}
		var buf bytes.Buffer
		if err := (ganFormat{}).Encode(&buf, p); err != nil {
			t.Fatalf("Encode: %v", err)
		}
		out := buf.String()
		for _, want := range []string{`<task id="1" name="First"`, `<task id="2" name="Second"`} {
			if !strings.Contains(out, want) {
				t.Errorf("encoded file misses %s\n%s", want, out)
			}
		}
		got, _, err := ganDecodeString(t, out)
		if err != nil {
			t.Fatalf("Decode: %v", err)
		}
		if len(got.Tasks) != 2 || got.Tasks[0].Key() != ganRoundDupRef || got.Tasks[1].Key() != ganRoundDupRef {
			t.Errorf("tasks = %+v, want the two rows sharing one Key", got.Tasks)
		}
	})

	// The second cut behind ganBreakCycles, exercised on the node graph itself: if
	// the first one ever misses a loop, build ends the row rather than the process.
	t.Run("build cuts a node graph that loops", func(t *testing.T) {
		a := &ganNode{i: 0, el: &ganTaskEl{ID: "1", Name: "A"}}
		b := &ganNode{i: 1, el: &ganTaskEl{ID: "2", Name: "B"}}
		a.children = []*ganNode{b}
		b.children = []*ganNode{a}

		done := make(chan ganTaskEl, 1)
		go func() { done <- a.build(map[int]bool{}) }()
		select {
		case el := <-done:
			// The loop is cut by re-emitting the re-entered node as a leaf: the
			// tree reads A -> B -> A, where the second A has no children.
			if len(el.Children) != 1 || el.Children[0].Name != "B" ||
				len(el.Children[0].Children) != 1 || el.Children[0].Children[0].Name != "A" ||
				len(el.Children[0].Children[0].Children) != 0 {
				t.Errorf("built tree = %+v, want A holding B which holds a childless A", el)
			}
		case <-time.After(10 * time.Second):
			t.Fatal("build did not cut the loop")
		}
	})
}

// TestGanEncode_EmptyPlan is the file an empty project exports as: it must stay
// readable by the decoder.
func TestGanEncode_EmptyPlan(t *testing.T) {
	var buf bytes.Buffer
	if err := (ganFormat{}).Encode(&buf, Plan{Name: "Vide"}); err != nil {
		t.Fatalf("Encode: %v", err)
	}
	p, warnings, err := ganDecodeString(t, buf.String())
	if err != nil {
		t.Fatalf("Decode: %v\n%s", err, buf.String())
	}
	if len(p.Tasks) != 0 || len(p.Deps) != 0 || len(p.Assignments) != 0 {
		t.Errorf("plan = %+v, want an empty one", p)
	}
	if p.Name != "Vide" || p.Weekend != DefaultWeekend || len(warnings) != 0 {
		t.Errorf("plan = %+v warnings %+v", p, warnings)
	}
}
