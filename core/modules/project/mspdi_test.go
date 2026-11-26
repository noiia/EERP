package project

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func mspdiDecodeFile(t *testing.T, name string) (Plan, []Warning) {
	t.Helper()
	f, err := os.Open(filepath.Join("testdata", "mspdi", name))
	if err != nil {
		t.Fatalf("open fixture: %v", err)
	}
	defer f.Close()
	p, warnings, err := mspdiFormat{}.Decode(f)
	if err != nil {
		t.Fatalf("Decode(%s): %v", name, err)
	}
	return p, warnings
}

func TestMspdiFormat(t *testing.T) {
	f, ok := formatByKey("mspdi")
	if !ok || f.Key() != "mspdi" || f.Ext() != ".xml" {
		t.Fatalf("formatByKey(mspdi) = %v %v, want the MSPDI adapter with .xml", f, ok)
	}
	for _, field := range []Field{FieldName, FieldDates, FieldHours, FieldClosed, FieldMilestone,
		FieldPriority, FieldDescription, FieldBaselines, FieldCapacity} {
		if !f.Carries(field) {
			t.Errorf("mspdi does not carry %s, want every field", field)
		}
	}
	for _, field := range []Field{FieldPriority, FieldDescription, FieldBaselines, FieldCapacity} {
		if (ganFormat{}).Carries(field) {
			t.Errorf(".gan carries %s, want it not to", field)
		}
	}
}

// TestMspdiDecode_Basic: basic.gan's assertions, plus the MS Project extras.
func TestMspdiDecode_Basic(t *testing.T) {
	p, warnings := mspdiDecodeFile(t, "basic.xml")
	if len(warnings) != 0 {
		t.Errorf("warnings = %+v, want none", warnings)
	}
	if p.Name != "House build" || p.Weekend != DefaultWeekend || p.HasHolidays {
		t.Errorf("Name/Weekend/HasHolidays = %q/%v/%v, want House build, DefaultWeekend, false", p.Name, p.Weekend, p.HasHolidays)
	}
	ganWantOrder(t, p, ganFoundationRef, ganExcavationRef, ganConcreteRef,
		ganSuperstructureRef, ganFramingRef, ganStructureRef)

	foundation := ganTask(t, p, ganFoundationRef)
	if !foundation.HasChildren || foundation.Parent != "" || foundation.Duration != 5 ||
		foundation.PlannedHours != 24 || foundation.FileID != "1" ||
		!foundation.Start.Equal(exchangeDay(2026, time.January, 5)) {
		t.Errorf("Foundation = %+v", foundation)
	}
	excavation := ganTask(t, p, ganExcavationRef)
	if excavation.Parent != ganFoundationRef || excavation.HasChildren || excavation.PlannedHours != 12 || excavation.Duration != 3 {
		t.Errorf("Excavation = %+v", excavation)
	}
	if !excavation.Priority || excavation.Notes != "Check the soil report first." {
		t.Errorf("Excavation priority/notes = %v/%q", excavation.Priority, excavation.Notes)
	}
	concrete := ganTask(t, p, ganConcreteRef)
	if concrete.Complete != 100 || concrete.Priority {
		t.Errorf("Concrete pour = %+v, want complete and normal priority", concrete)
	}
	milestone := p.Tasks[len(p.Tasks)-1]
	if !milestone.Milestone || milestone.Ref != ganStructureRef || milestone.Parent != "" || milestone.Duration != 0 {
		t.Errorf("milestone = %+v", milestone)
	}

	wantDeps := []PlanDep{
		{Pred: ganConcreteRef, Succ: ganFramingRef, Type: DepFS},
		{Pred: ganFramingRef, Succ: ganStructureRef, Type: DepFS},
	}
	if !reflect.DeepEqual(p.Deps, wantDeps) {
		t.Errorf("Deps = %+v, want %+v", p.Deps, wantDeps)
	}
	wantAssigns := []PlanAssign{{Task: ganFramingRef, Email: "ann@x.com", Name: "Ann Lee"}}
	if !reflect.DeepEqual(p.Assignments, wantAssigns) {
		t.Errorf("Assignments = %+v, want %+v", p.Assignments, wantAssigns)
	}
	if len(p.Baselines) != 1 || p.Baselines[0].Number != 0 {
		t.Fatalf("Baselines = %+v, want Baseline 0", p.Baselines)
	}
	b := p.Baselines[0].Tasks[ganExcavationRef]
	if !b.Start.Equal(exchangeDay(2026, time.January, 5)) || b.Duration != 2 || b.Work != 10 {
		t.Errorf("Baseline 0 of Excavation = %+v, want 2026-01-05, 2 days, 10 h", b)
	}
	wantRes := []PlanResource{{Email: "ann@x.com", Name: "Ann Lee", HoursPerWeek: 24}}
	if !reflect.DeepEqual(p.Resources, wantRes) {
		t.Errorf("Resources = %+v, want %+v", p.Resources, wantRes)
	}
}

// TestMspdiDecode_AutoScheduled: a task MS Project switched to auto-scheduling
// and moved decodes with the file's dates (Review Focus 2).
func TestMspdiDecode_AutoScheduled(t *testing.T) {
	p, _ := mspdiDecodeFile(t, "odd.xml")
	bravo := ganTask(t, p, ganLongRef)
	if !bravo.Start.Equal(exchangeDay(2026, time.March, 4)) || bravo.Duration != 3 {
		t.Errorf("Bravo = %s for %d days, want 2026-03-04 for 3", bravo.Start, bravo.Duration)
	}
}

func TestMspdiDecode_Odd(t *testing.T) {
	p, warnings := mspdiDecodeFile(t, "odd.xml")
	if !p.HasHolidays || len(warnings) != 1 || warnings[0].Code != "HOLIDAYS" {
		t.Errorf("HasHolidays/warnings = %v/%+v, want one HOLIDAYS", p.HasHolidays, warnings)
	}
	wantDeps := []PlanDep{
		{Pred: ganAlphaRef, Succ: ganLongRef, Type: DepSS},
		{Pred: ganLongRef, Succ: ganCharlieRef, Type: DepFS, Lag: 2},
	}
	if !reflect.DeepEqual(p.Deps, wantDeps) {
		t.Errorf("Deps = %+v, want %+v", p.Deps, wantDeps)
	}
	if n := utf8.RuneCountInString(ganTask(t, p, ganAlphaRef).Notes); n != 6000 {
		t.Errorf("Alpha's note holds %d characters, want the file's 6000 (the diff truncates, not the codec)", n)
	}
	if got := mspdiLag("10"); got != 1 {
		t.Errorf("a lag under a day = %d, want 1: never rounded to no lag", got)
	}
}

// TestMspdiRoundTrip: what the encoder writes decodes to the same plan.
func TestMspdiRoundTrip(t *testing.T) {
	want := Plan{
		Name:    "Round trip",
		Weekend: Weekend{time.Friday: true, time.Saturday: true},
		Tasks: []PlanTask{
			{Ref: ganRoundA, FileID: "1", Name: "Design", Start: exchangeDay(2026, time.January, 4), Duration: 5, PlannedHours: 7.5, HasChildren: true, Notes: "line 1\nline 2 <b>&amp;</b>"},
			{Ref: ganRoundB, FileID: "2", Parent: ganRoundA, Name: "Draft", Start: exchangeDay(2026, time.January, 4), Duration: 3, PlannedHours: 4, Priority: true},
			{Ref: ganRoundC, FileID: "3", Parent: ganRoundA, Name: "Review", Start: exchangeDay(2026, time.January, 7), Duration: 2, Complete: 100},
			{FileID: "4", Name: "New one", Start: exchangeDay(2026, time.January, 11), Duration: 1},
			{Ref: ganRoundGate, FileID: "5", Name: "Gate", Start: exchangeDay(2026, time.January, 12), Milestone: true},
		},
		Deps:        []PlanDep{{Pred: ganRoundB, Succ: ganRoundC, Type: DepFS}, {Pred: ganRoundC, Succ: ganRoundGate, Type: DepFS}},
		Assignments: []PlanAssign{{Task: ganRoundB, Email: "ann@x.com", Name: "Ann Lee"}},
		Baselines: []PlanBaseline{
			{Number: 0, Tasks: map[string]BaselineTask{ganRoundB: {Start: exchangeDay(2026, time.January, 4), Duration: 2, Work: 3}}},
			{Number: 3, Tasks: map[string]BaselineTask{ganRoundC: {Start: exchangeDay(2026, time.January, 5), Duration: 1, Work: 1.25}}},
		},
		Resources: []PlanResource{{Email: "ann@x.com", Name: "Ann Lee", HoursPerWeek: 25}},
	}
	var buf bytes.Buffer
	if err := (mspdiFormat{}).Encode(&buf, want); err != nil {
		t.Fatalf("Encode: %v", err)
	}
	got, warnings, err := mspdiFormat{}.Decode(&buf)
	if err != nil {
		t.Fatalf("Decode: %v\n%s", err, buf.String())
	}
	if len(warnings) != 0 {
		t.Errorf("warnings = %+v", warnings)
	}
	// The new row's file id is its UID, which is its place in the file.
	want.Tasks[3].FileID = "4"
	if d := ganTaskDiff(want.Tasks, got.Tasks); d != "" {
		t.Errorf("tasks differ:\n%s", d)
	}
	for _, f := range []string{"Name", "Weekend", "Deps", "Assignments", "Baselines", "Resources"} {
		w, g := reflect.ValueOf(want).FieldByName(f).Interface(), reflect.ValueOf(got).FieldByName(f).Interface()
		if !reflect.DeepEqual(w, g) {
			t.Errorf("%s = %+v, want %+v", f, g, w)
		}
	}
}

func TestMspdiEncode_Shape(t *testing.T) {
	var buf bytes.Buffer
	p := Plan{Name: "P", Weekend: DefaultWeekend, Tasks: []PlanTask{
		{Ref: ganRoundA, Name: "A", Start: exchangeDay(2026, time.January, 5), Duration: 5, PlannedHours: 16, ActualHours: 4},
	}}
	if err := (mspdiFormat{}).Encode(&buf, p); err != nil {
		t.Fatal(err)
	}
	out := buf.String()
	for _, want := range []string{
		`<Project xmlns="http://schemas.microsoft.com/project">`,
		"<Manual>1</Manual>", "<Start>2026-01-05T08:00:00</Start>", "<Finish>2026-01-09T17:00:00</Finish>",
		"<Duration>PT40H0M0S</Duration>", "<Work>PT16H0M0S</Work>", "<ActualWork>PT4H0M0S</ActualWork>",
		"<Priority>500</Priority>", "<Alias>EERP id</Alias>", "<Value>" + ganRoundA + "</Value>",
		"<GUID>" + strings.ToUpper(ganRoundA) + "</GUID>", "<UID>0</UID>",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("the file lacks %s:\n%s", want, out)
		}
	}
}

func TestMspdiDecode_Malformed(t *testing.T) {
	basic, err := os.ReadFile(filepath.Join("testdata", "mspdi", "basic.xml"))
	if err != nil {
		t.Fatal(err)
	}
	for name, doc := range map[string]string{
		"truncated":       string(basic[:len(basic)/2]),
		"entity":          `<?xml version="1.0"?><!DOCTYPE Project [<!ENTITY a "aaaa">]><Project xmlns="http://schemas.microsoft.com/project"><Name>&a;</Name></Project>`,
		"wrong root":      `<project name="x"/>`,
		"wrong namespace": `<Project xmlns="http://example.com/other"><Name>x</Name></Project>`,
		"no namespace":    `<Project><Name>x</Name></Project>`,
		"empty":           ``,
		"no UID":          `<Project xmlns="http://schemas.microsoft.com/project"><Tasks><Task><Name>x</Name></Task></Tasks></Project>`,
		"no worked day":   `<Project xmlns="http://schemas.microsoft.com/project"><Calendars><Calendar><UID>1</UID><WeekDays>` + mspdiAllOff() + `</WeekDays></Calendar></Calendars></Project>`,
	} {
		t.Run(name, func(t *testing.T) {
			if _, _, err := (mspdiFormat{}).Decode(strings.NewReader(doc)); !errors.Is(err, errNotMspdi) {
				t.Errorf("Decode = %v, want errNotMspdi", err)
			}
		})
	}
}

func mspdiAllOff() string {
	var b strings.Builder
	for d := 1; d <= 7; d++ {
		b.WriteString("<WeekDay><DayType>" + strconv.Itoa(d) + "</DayType><DayWorking>0</DayWorking></WeekDay>")
	}
	return b.String()
}

func TestMspdiDecode_TooManyTasks(t *testing.T) {
	var b strings.Builder
	b.WriteString(`<Project xmlns="http://schemas.microsoft.com/project"><Tasks>`)
	for i := 1; i <= ganMaxTasks+1; i++ {
		b.WriteString("<Task><UID>" + strconv.Itoa(i) + "</UID><Name>t</Name></Task>")
	}
	b.WriteString("</Tasks></Project>")
	_, _, err := mspdiFormat{}.Decode(strings.NewReader(b.String()))
	if !errors.Is(err, errPlanTooBig) || !errors.Is(err, errNotMspdi) {
		t.Errorf("Decode of %d tasks = %v, want errPlanTooBig", ganMaxTasks+1, err)
	}
}

func TestMspdiHours(t *testing.T) {
	for in, want := range map[string]float64{"PT16H0M0S": 16, "PT7H30M0S": 7.5, "PT0H0M36S": 0.01, "PT1H0M0.5S": 1 + 0.5/3600} {
		if got, err := parseMspdiHours(in); err != nil || got != want {
			t.Errorf("parseMspdiHours(%q) = %v, %v; want %v", in, got, err, want)
		}
	}
	for _, bad := range []string{"P1D", "PT8H", "-PT8H0M0S", "PT8H0M0S junk", ""} {
		if _, err := parseMspdiHours(bad); err == nil {
			t.Errorf("parseMspdiHours(%q) accepted it", bad)
		}
	}
	if got := formatMspdiHours(7.5); got != "PT7H30M0S" {
		t.Errorf("formatMspdiHours(7.5) = %s", got)
	}
}
