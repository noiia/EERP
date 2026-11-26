package project

import (
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

// The mspdi format: Microsoft Project Data Interchange, the XML MS Project opens
// and saves natively (File → Save As → XML Format). The closed .mpp binary is not
// supported; see ADR-042 § MS Project and the design in
// docs/superpowers/specs/2026-11-18-project-msproject-exchange-design.md.
//
// Three rules shape the file:
//
//   - Tasks are written manually scheduled (<Manual>1</Manual>), so MS Project
//     keeps EERP's dates on open instead of rescheduling them.
//   - The EERP identity rides in the task extended attribute Text30, aliased
//     "EERP id". The decoder finds that attribute's FieldID by its alias in the
//     file's <ExtendedAttributes>, never by a hard-coded id. The task GUID is set
//     to the task uuid as well, and ignored on read.
//   - Elements are written in the order the MSPDI schema's sequences declare:
//     MS Project refuses a file whose children are out of order.
//
// Dates are read from the date part of Start/Finish, and the duration is the
// working days between them on the file's calendar: the Duration element is
// written, never read, so a task MS Project switched to auto-scheduling and
// re-timed still decodes, as a date change.

const (
	mspdiFormatKey = "mspdi"
	mspdiFormatExt = ".xml"
	mspdiNamespace = "http://schemas.microsoft.com/project"
	mspdiRoot      = "Project"

	// mspdiEERPAlias names the extended attribute holding the EERP id;
	// mspdiEERPField and mspdiEERPFieldID are what the encoder declares it as
	// (task Text30). The decoder resolves the id by the alias only.
	mspdiEERPAlias   = "EERP id"
	mspdiEERPField   = "Text30"
	mspdiEERPFieldID = "188744006"

	// A working day is 8 hours (MinutesPerDay 480), 08:00 to 17:00 with lunch.
	mspdiHoursPerDay = 8
	mspdiStartTime   = "T08:00:00"
	mspdiFinishTime  = "T17:00:00"
	mspdiDateTime    = "2006-01-02T15:04:05"

	// mspdiLagPerDay is a one-day lag in LinkLag's unit, tenths of a minute.
	mspdiLagPerDay = 4800
	// mspdiLagDays is LagFormat 7: the lag shown in days.
	mspdiLagDays = "7"
	// mspdiDurationDays is DurationFormat 7: durations shown in days.
	mspdiDurationDays = "7"

	// Priority: 500 is MS Project's default, 1000 its highest. EERP's flag is
	// written as either, and anything above the default reads as the flag.
	mspdiPriorityHigh   = "1000"
	mspdiPriorityNormal = "500"
)

// The PredecessorLink Type codes.
const (
	mspdiTypeFF = "0"
	mspdiTypeFS = "1"
	mspdiTypeSF = "2"
	mspdiTypeSS = "3"
)

// errNotMspdi marks "this is not an MSPDI file", which the route answers 422
// INVALID_FILE.
var errNotMspdi = errors.New("not a Microsoft Project XML file")

type mspdiFormat struct{}

func init() { registerFormat(mspdiFormat{}) }

func (mspdiFormat) Key() string { return mspdiFormatKey }
func (mspdiFormat) Ext() string { return mspdiFormatExt }

// Carries: an MSPDI file holds every field the exchange knows.
func (mspdiFormat) Carries(Field) bool { return true }

// The document, as far as EERP cares. Field order is the schema's element order.
// Numbers stay strings so a garbage value degrades the way .gan's do instead of
// failing the whole file.

type mspdiProjectEl struct {
	XMLName            xml.Name          `xml:"http://schemas.microsoft.com/project Project"`
	SaveVersion        string            `xml:"SaveVersion,omitempty"`
	Name               string            `xml:"Name,omitempty"`
	ScheduleFromStart  string            `xml:"ScheduleFromStart,omitempty"`
	StartDate          string            `xml:"StartDate,omitempty"`
	CalendarUID        string            `xml:"CalendarUID,omitempty"`
	MinutesPerDay      string            `xml:"MinutesPerDay,omitempty"`
	MinutesPerWeek     string            `xml:"MinutesPerWeek,omitempty"`
	ExtendedAttributes []mspdiAttrDefEl  `xml:"ExtendedAttributes>ExtendedAttribute"`
	Calendars          []mspdiCalendarEl `xml:"Calendars>Calendar"`
	Tasks              []mspdiTaskEl     `xml:"Tasks>Task"`
	Resources          []mspdiResourceEl `xml:"Resources>Resource"`
	Assignments        []mspdiAssignEl   `xml:"Assignments>Assignment"`
}

type mspdiAttrDefEl struct {
	FieldID   string `xml:"FieldID"`
	FieldName string `xml:"FieldName"`
	Alias     string `xml:"Alias,omitempty"`
}

type mspdiCalendarEl struct {
	UID            string           `xml:"UID"`
	Name           string           `xml:"Name,omitempty"`
	IsBaseCalendar string           `xml:"IsBaseCalendar,omitempty"`
	WeekDays       []mspdiWeekDayEl `xml:"WeekDays>WeekDay"`
	Exceptions     []mspdiAnyEl     `xml:"Exceptions>Exception"`
}

type mspdiWeekDayEl struct {
	DayType      string          `xml:"DayType"`
	DayWorking   string          `xml:"DayWorking"`
	WorkingTimes []mspdiPeriodEl `xml:"WorkingTimes>WorkingTime,omitempty"`
}

type mspdiPeriodEl struct {
	FromTime string `xml:"FromTime"`
	ToTime   string `xml:"ToTime"`
}

// mspdiAnyEl is an element whose content EERP does not read, only counts.
type mspdiAnyEl struct{}

type mspdiTaskEl struct {
	UID              string            `xml:"UID"`
	GUID             string            `xml:"GUID,omitempty"`
	ID               string            `xml:"ID,omitempty"`
	Name             string            `xml:"Name,omitempty"`
	Active           string            `xml:"Active,omitempty"`
	Manual           string            `xml:"Manual,omitempty"`
	IsNull           string            `xml:"IsNull,omitempty"`
	WBS              string            `xml:"WBS,omitempty"`
	OutlineNumber    string            `xml:"OutlineNumber,omitempty"`
	OutlineLevel     string            `xml:"OutlineLevel,omitempty"`
	Priority         string            `xml:"Priority,omitempty"`
	Start            string            `xml:"Start,omitempty"`
	Finish           string            `xml:"Finish,omitempty"`
	Duration         string            `xml:"Duration,omitempty"`
	ManualStart      string            `xml:"ManualStart,omitempty"`
	ManualFinish     string            `xml:"ManualFinish,omitempty"`
	ManualDuration   string            `xml:"ManualDuration,omitempty"`
	DurationFormat   string            `xml:"DurationFormat,omitempty"`
	Work             string            `xml:"Work,omitempty"`
	Milestone        string            `xml:"Milestone,omitempty"`
	Summary          string            `xml:"Summary,omitempty"`
	PercentComplete  string            `xml:"PercentComplete,omitempty"`
	ActualWork       string            `xml:"ActualWork,omitempty"`
	Notes            string            `xml:"Notes,omitempty"`
	PredecessorLinks []mspdiPredEl     `xml:"PredecessorLink"`
	ExtendedAttrs    []mspdiAttrValEl  `xml:"ExtendedAttribute"`
	Baselines        []mspdiBaselineEl `xml:"Baseline"`
}

type mspdiPredEl struct {
	PredecessorUID string `xml:"PredecessorUID"`
	Type           string `xml:"Type,omitempty"`
	LinkLag        string `xml:"LinkLag,omitempty"`
	LagFormat      string `xml:"LagFormat,omitempty"`
}

type mspdiAttrValEl struct {
	FieldID string `xml:"FieldID"`
	Value   string `xml:"Value"`
}

type mspdiBaselineEl struct {
	Number         string `xml:"Number"`
	Start          string `xml:"Start,omitempty"`
	Finish         string `xml:"Finish,omitempty"`
	Duration       string `xml:"Duration,omitempty"`
	DurationFormat string `xml:"DurationFormat,omitempty"`
	Work           string `xml:"Work,omitempty"`
}

type mspdiResourceEl struct {
	UID          string `xml:"UID"`
	ID           string `xml:"ID,omitempty"`
	Name         string `xml:"Name,omitempty"`
	Type         string `xml:"Type,omitempty"`
	EmailAddress string `xml:"EmailAddress,omitempty"`
	MaxUnits     string `xml:"MaxUnits,omitempty"`
}

type mspdiAssignEl struct {
	UID         string `xml:"UID"`
	TaskUID     string `xml:"TaskUID"`
	ResourceUID string `xml:"ResourceUID"`
	Units       string `xml:"Units,omitempty"`
}

// ── Decode ───────────────────────────────────────────────────────────────────

// Decode reads an MSPDI file. Strict mode refuses a truncated file and an entity
// reference (encoding/xml never expands a declared entity), like the .gan reader.
func (mspdiFormat) Decode(r io.Reader) (Plan, []Warning, error) {
	dec := xml.NewDecoder(r)
	dec.Strict = true
	var root xml.StartElement
	for {
		tok, err := dec.Token()
		if err != nil {
			return Plan{}, nil, fmt.Errorf("%w: %v", errNotMspdi, err)
		}
		if start, ok := tok.(xml.StartElement); ok {
			root = start
			break
		}
	}
	if root.Name.Local != mspdiRoot || root.Name.Space != mspdiNamespace {
		return Plan{}, nil, fmt.Errorf("%w: root element is <%s xmlns=%q>", errNotMspdi, root.Name.Local, root.Name.Space)
	}
	var doc mspdiProjectEl
	if err := dec.DecodeElement(&doc, &root); err != nil {
		return Plan{}, nil, fmt.Errorf("%w: %v", errNotMspdi, err)
	}
	return doc.toPlan()
}

func (doc *mspdiProjectEl) toPlan() (Plan, []Warning, error) {
	p := Plan{Name: doc.Name, Weekend: DefaultWeekend}
	var warnings []Warning

	if cal := doc.calendar(); cal != nil {
		w, holidays := cal.weekend()
		if !w.hasWorkedDay() {
			return Plan{}, nil, fmt.Errorf("%w: the calendar works no day", errNotMspdi)
		}
		p.Weekend = w
		if holidays {
			p.HasHolidays = true
			warnings = append(warnings, Warning{Code: "HOLIDAYS",
				Message: "the file defines holidays; only its weekends are used"})
		}
	}

	eerpField := ""
	for _, a := range doc.ExtendedAttributes {
		if strings.TrimSpace(a.Alias) == mspdiEERPAlias {
			eerpField = strings.TrimSpace(a.FieldID)
			break
		}
	}

	var tasks, milestones []PlanTask
	byUID := map[string]string{} // file UID → Key()
	type pending struct {
		succ string
		link mspdiPredEl
	}
	var preds []pending
	baselines := map[int]map[string]BaselineTask{}
	// stack[l-1] is the index into tasks of the last row seen at outline level l.
	var stack []int
	count := 0
	for _, el := range doc.Tasks {
		uid := strings.TrimSpace(el.UID)
		if uid == "0" || mspdiTrue(el.IsNull) {
			continue // MS Project's project summary row, and its blank rows
		}
		if uid == "" {
			return Plan{}, nil, fmt.Errorf("%w: a <Task> has no UID", errNotMspdi)
		}
		count++
		if count > ganMaxTasks {
			return Plan{}, nil, fmt.Errorf("%w: %w", errNotMspdi, errPlanTooBig)
		}
		start := mspdiDay(el.Start)
		task := PlanTask{
			Ref:          mspdiRef(el, eerpField, &warnings),
			FileID:       uid,
			Name:         el.Name,
			Start:        start,
			Duration:     workdaysBetween(start, mspdiDay(el.Finish), p.Weekend),
			PlannedHours: mspdiHoursOr0(el.Work),
			Complete:     ganInt(el.PercentComplete, 0, 100),
			Milestone:    mspdiTrue(el.Milestone),
			HasChildren:  mspdiTrue(el.Summary),
			Priority:     ganInt(el.Priority, 0, 1000) > 500,
			Notes:        el.Notes,
			ActualHours:  mspdiHoursOr0(el.ActualWork),
		}
		if start.IsZero() {
			task.Duration = 0
		}

		level := ganInt(el.OutlineLevel, 1, len(stack)+1)
		stack = stack[:level-1]
		parent := -1
		if level > 1 {
			parent = stack[level-2]
		}

		key := task.Key()
		if task.Milestone {
			task.Duration = 0
			milestones = append(milestones, task)
			// A milestone holds no children in EERP: rows MS Project nests under one
			// hang from the milestone's own parent.
			if parent >= 0 {
				stack = append(stack, parent)
			} else {
				stack = append(stack, -1)
			}
		} else {
			if parent >= 0 {
				task.Parent = tasks[parent].Key()
				tasks[parent].HasChildren = true
			}
			tasks = append(tasks, task)
			stack = append(stack, len(tasks)-1)
		}
		if _, dup := byUID[uid]; !dup {
			byUID[uid] = key
		}
		for _, link := range el.PredecessorLinks {
			preds = append(preds, pending{succ: key, link: link})
		}
		if !task.Milestone {
			for _, b := range el.Baselines {
				n := ganInt(b.Number, -1, planBaselineSlots-1)
				bStart := mspdiDay(b.Start)
				if n < 0 || bStart.IsZero() {
					continue
				}
				if baselines[n] == nil {
					baselines[n] = map[string]BaselineTask{}
				}
				baselines[n][key] = BaselineTask{
					Start:    bStart,
					Duration: workdaysBetween(bStart, mspdiDay(b.Finish), p.Weekend),
					Work:     mspdiHoursOr0(b.Work),
				}
			}
		}
	}
	p.Tasks = append(tasks, milestones...)

	for _, pd := range preds {
		pred, ok := byUID[strings.TrimSpace(pd.link.PredecessorUID)]
		if !ok {
			continue
		}
		p.Deps = append(p.Deps, PlanDep{Pred: pred, Succ: pd.succ, Type: mspdiDepType(pd.link.Type), Lag: mspdiLag(pd.link.LinkLag)})
	}
	for n := 0; n < planBaselineSlots; n++ {
		if tasks, ok := baselines[n]; ok {
			p.Baselines = append(p.Baselines, PlanBaseline{Number: n, Tasks: tasks})
		}
	}
	p.Resources, p.Assignments = doc.people(byUID)
	return p, warnings, nil
}

// calendar is the project's calendar: the one CalendarUID names, else the first
// base calendar, else the first.
func (doc *mspdiProjectEl) calendar() *mspdiCalendarEl {
	for i := range doc.Calendars {
		if strings.TrimSpace(doc.Calendars[i].UID) == strings.TrimSpace(doc.CalendarUID) && doc.CalendarUID != "" {
			return &doc.Calendars[i]
		}
	}
	for i := range doc.Calendars {
		if mspdiTrue(doc.Calendars[i].IsBaseCalendar) {
			return &doc.Calendars[i]
		}
	}
	if len(doc.Calendars) > 0 {
		return &doc.Calendars[0]
	}
	return nil
}

// weekend reads the working weekdays (DayType 1 = Sunday … 7 = Saturday), and
// whether the calendar declares exceptions: the <Exceptions> block, or the older
// form, a DayType 0 entry for a non-worked date.
func (c *mspdiCalendarEl) weekend() (Weekend, bool) {
	w := DefaultWeekend
	holidays := len(c.Exceptions) > 0
	for _, d := range c.WeekDays {
		t := ganInt(d.DayType, -1, 7)
		switch {
		case t >= 1:
			w[t-1] = !mspdiTrue(d.DayWorking)
		case t == 0 && !mspdiTrue(d.DayWorking):
			holidays = true
		}
	}
	return w, holidays
}

// mspdiRef reads a task's EERP identity off the "EERP id" extended attribute.
// The rules are the .gan ones (see ganWalker.eerpRef).
func mspdiRef(el mspdiTaskEl, field string, warnings *[]Warning) string {
	if field == "" {
		return ""
	}
	ref := ""
	for _, a := range el.ExtendedAttrs {
		if strings.TrimSpace(a.FieldID) == field {
			ref = strings.TrimSpace(a.Value)
			break
		}
	}
	if ref == "" {
		return ""
	}
	if validRef(ref) {
		return canonicalRef(ref)
	}
	*warnings = append(*warnings, Warning{Code: warnUnknownID,
		Message: "the file's EERP id is not an EERP id; the task is imported as a new task", Task: el.Name})
	return ""
}

// people reads the resources with an email (how EERP names staff) and the
// assignments of them to the file's tasks, one per task and person.
func (doc *mspdiProjectEl) people(byUID map[string]string) ([]PlanResource, []PlanAssign) {
	byRes := map[string]mspdiResourceEl{}
	var resources []PlanResource
	seen := map[string]bool{}
	for _, r := range doc.Resources {
		uid := strings.TrimSpace(r.UID)
		email := strings.TrimSpace(r.EmailAddress)
		if uid == "" || email == "" {
			continue
		}
		if _, dup := byRes[uid]; dup {
			continue
		}
		byRes[uid] = r
		if seen[strings.ToLower(email)] {
			continue
		}
		seen[strings.ToLower(email)] = true
		hours := float64(defaultHoursPerWeek)
		if units, err := strconv.ParseFloat(strings.TrimSpace(r.MaxUnits), 64); err == nil && !math.IsNaN(units) && !math.IsInf(units, 0) {
			hours = math.Round(units*defaultHoursPerWeek*100) / 100
		}
		resources = append(resources, PlanResource{Email: email, Name: r.Name, HoursPerWeek: hours})
	}
	var assigns []PlanAssign
	dup := map[PlanAssign]bool{}
	for _, a := range doc.Assignments {
		task, ok := byUID[strings.TrimSpace(a.TaskUID)]
		if !ok {
			continue
		}
		r, ok := byRes[strings.TrimSpace(a.ResourceUID)]
		if !ok {
			continue
		}
		pa := PlanAssign{Task: task, Email: strings.TrimSpace(r.EmailAddress), Name: r.Name}
		if dup[pa] {
			continue
		}
		dup[pa] = true
		assigns = append(assigns, pa)
	}
	return resources, assigns
}

// mspdiDay reads the date part of an MSPDI date-time as UTC midnight; an absent
// or unparsable value is the zero day, as in .gan.
func mspdiDay(value string) time.Time {
	value = strings.TrimSpace(value)
	if len(value) < len(exchangeDayLayout) {
		return time.Time{}
	}
	t, err := time.Parse(exchangeDayLayout, value[:len(exchangeDayLayout)])
	if err != nil {
		return time.Time{}
	}
	return t
}

func mspdiTrue(value string) bool {
	return ganTrue(strings.TrimSpace(value))
}

// mspdiDurationRe is the only duration shape MSPDI writes: PT<h>H<m>M<s>S.
var mspdiDurationRe = regexp.MustCompile(`^PT([0-9]{1,9})H([0-9]{1,9})M([0-9]{1,9}(?:\.[0-9]{1,9})?)S$`)

// parseMspdiHours reads a PT<h>H<m>M<s>S duration as hours.
func parseMspdiHours(value string) (float64, error) {
	m := mspdiDurationRe.FindStringSubmatch(strings.TrimSpace(value))
	if m == nil {
		return 0, fmt.Errorf("%w: duration %q", errNotMspdi, value)
	}
	h, _ := strconv.ParseFloat(m[1], 64)
	min, _ := strconv.ParseFloat(m[2], 64)
	s, _ := strconv.ParseFloat(m[3], 64)
	return h + min/60 + s/3600, nil
}

// mspdiHoursOr0 is parseMspdiHours for a value EERP can do without: an absent
// or malformed figure reads as 0, the way .gan's planned_hours does.
func mspdiHoursOr0(value string) float64 {
	if strings.TrimSpace(value) == "" {
		return 0
	}
	h, err := parseMspdiHours(value)
	if err != nil {
		return 0
	}
	return h
}

// formatMspdiHours writes hours as PT<h>H<m>M<s>S, to the second.
func formatMspdiHours(hours float64) string {
	if math.IsNaN(hours) || math.IsInf(hours, 0) || hours < 0 {
		hours = 0
	}
	total := int64(math.Round(hours * 3600))
	return fmt.Sprintf("PT%dH%dM%dS", total/3600, total%3600/60, total%60)
}

func mspdiDepType(code string) DepType {
	switch strings.TrimSpace(code) {
	case mspdiTypeFF:
		return DepFF
	case mspdiTypeSF:
		return DepSF
	case mspdiTypeSS:
		return DepSS
	default:
		return DepFS
	}
}

func mspdiDepCode(t DepType) string {
	switch t {
	case DepFF:
		return mspdiTypeFF
	case DepSF:
		return mspdiTypeSF
	case DepSS:
		return mspdiTypeSS
	default:
		return mspdiTypeFS
	}
}

// mspdiLag reads LinkLag (tenths of a minute) as whole days, never rounding a
// non-zero lag to 0: any lag is enough for the DEP_LAG warning.
func mspdiLag(value string) int {
	n, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
	if err != nil || n == 0 {
		return 0
	}
	days := n / mspdiLagPerDay
	if days == 0 {
		if n < 0 {
			return -1
		}
		return 1
	}
	return int(max(min(days, maxWorkdayCount), -maxWorkdayCount))
}

// ── Encode ───────────────────────────────────────────────────────────────────

// Encode writes the plan as MSPDI. Task UIDs are 1..n in document order with the
// milestones last; UID 0 is MS Project's project summary row.
func (mspdiFormat) Encode(w io.Writer, p Plan) error {
	if _, err := io.WriteString(w, xml.Header); err != nil {
		return err
	}
	enc := xml.NewEncoder(w)
	enc.Indent("", "  ")
	if err := enc.Encode(mspdiDocument(p)); err != nil {
		return fmt.Errorf("encode %s: %w", mspdiFormatExt, err)
	}
	if err := enc.Flush(); err != nil {
		return fmt.Errorf("encode %s: %w", mspdiFormatExt, err)
	}
	_, err := io.WriteString(w, "\n")
	return err
}

func mspdiDocument(p Plan) *mspdiProjectEl {
	week := p.Weekend
	if week == (Weekend{}) || !week.hasWorkedDay() {
		week = DefaultWeekend
	}
	worked := 0
	for _, off := range week {
		if !off {
			worked++
		}
	}

	order := mspdiOrder(p)
	uids := map[string]string{}
	for i, t := range order {
		if _, dup := uids[t.task.Key()]; !dup {
			uids[t.task.Key()] = strconv.Itoa(i + 1)
		}
	}
	preds := map[string][]mspdiPredEl{}
	nested := p.nestedDeps()
	for i, d := range p.Deps {
		pred, ok := uids[d.Pred]
		if !ok || nested[i] {
			continue
		}
		if _, ok := uids[d.Succ]; !ok {
			continue
		}
		preds[d.Succ] = append(preds[d.Succ], mspdiPredEl{
			PredecessorUID: pred,
			Type:           mspdiDepCode(d.Type),
			LinkLag:        strconv.Itoa(ganClamp(d.Lag, -maxWorkdayCount, maxWorkdayCount) * mspdiLagPerDay),
			LagFormat:      mspdiLagDays,
		})
	}
	baselines := map[string][]mspdiBaselineEl{}
	for _, b := range p.Baselines {
		for key, bt := range b.Tasks {
			baselines[key] = append(baselines[key], mspdiBaselineEl{
				Number:         strconv.Itoa(b.Number),
				Start:          mspdiStamp(bt.Start, mspdiStartTime),
				Finish:         mspdiStamp(endAfter(bt.Start, bt.Duration, week), mspdiFinishTime),
				Duration:       formatMspdiHours(float64(bt.Duration * mspdiHoursPerDay)),
				DurationFormat: mspdiDurationDays,
				Work:           formatMspdiHours(bt.Work),
			})
		}
	}
	for key := range baselines {
		list := baselines[key]
		// Map iteration above is random; the file is not.
		for i := 1; i < len(list); i++ {
			for j := i; j > 0 && ganInt(list[j].Number, 0, 99) < ganInt(list[j-1].Number, 0, 99); j-- {
				list[j], list[j-1] = list[j-1], list[j]
			}
		}
	}

	var first, last time.Time
	tasks := []mspdiTaskEl{{}}
	for i, o := range order {
		t := o.task
		key := t.Key()
		own := uids[key] == strconv.Itoa(i+1)
		duration := t.Duration
		if t.Milestone {
			duration = 0
		}
		finish := endAfter(t.Start, duration, week)
		finishTime := mspdiFinishTime
		if t.Milestone {
			finishTime = mspdiStartTime
		}
		if !t.Start.IsZero() && (first.IsZero() || t.Start.Before(first)) {
			first = t.Start
		}
		if !t.Start.IsZero() && finish.After(last) {
			last = finish
		}
		el := mspdiTaskEl{
			UID:             strconv.Itoa(i + 1),
			ID:              strconv.Itoa(i + 1),
			Name:            t.Name,
			Active:          "1",
			Manual:          "1",
			WBS:             o.outline,
			OutlineNumber:   o.outline,
			OutlineLevel:    strconv.Itoa(o.level),
			Priority:        mspdiPriorityNormal,
			Start:           mspdiStamp(t.Start, mspdiStartTime),
			Finish:          mspdiStamp(finish, finishTime),
			Duration:        formatMspdiHours(float64(duration * mspdiHoursPerDay)),
			DurationFormat:  mspdiDurationDays,
			Work:            formatMspdiHours(t.PlannedHours),
			Milestone:       mspdiBool(t.Milestone),
			Summary:         mspdiBool(t.HasChildren && !t.Milestone),
			PercentComplete: strconv.Itoa(ganClamp(t.Complete, 0, 100)),
			ActualWork:      formatMspdiHours(t.ActualHours),
			Notes:           t.Notes,
		}
		el.ManualStart, el.ManualFinish, el.ManualDuration = el.Start, el.Finish, el.Duration
		if t.Priority {
			el.Priority = mspdiPriorityHigh
		}
		if id, err := uuid.Parse(strings.TrimPrefix(t.Ref, milestoneRefPrefix)); err == nil {
			el.GUID = strings.ToUpper(id.String())
		}
		if t.Ref != "" {
			el.ExtendedAttrs = []mspdiAttrValEl{{FieldID: mspdiEERPFieldID, Value: t.Ref}}
		}
		if own {
			el.PredecessorLinks = preds[key]
			el.Baselines = baselines[key]
		}
		tasks = append(tasks, el)
	}
	tasks[0] = mspdiTaskEl{
		UID: "0", ID: "0", Name: p.Name, Active: "1", Manual: "1",
		WBS: "0", OutlineNumber: "0", OutlineLevel: "0", Priority: mspdiPriorityNormal,
		Start: mspdiStamp(first, mspdiStartTime), Finish: mspdiStamp(last, mspdiFinishTime),
		Summary: "1", Milestone: "0", PercentComplete: "0",
	}

	resources, assignments := mspdiPeople(p, uids)
	return &mspdiProjectEl{
		SaveVersion:       "14",
		Name:              p.Name,
		ScheduleFromStart: "1",
		StartDate:         mspdiStamp(first, mspdiStartTime),
		CalendarUID:       "1",
		MinutesPerDay:     strconv.Itoa(mspdiHoursPerDay * 60),
		MinutesPerWeek:    strconv.Itoa(mspdiHoursPerDay * 60 * worked),
		ExtendedAttributes: []mspdiAttrDefEl{{
			FieldID: mspdiEERPFieldID, FieldName: mspdiEERPField, Alias: mspdiEERPAlias,
		}},
		Calendars:   []mspdiCalendarEl{mspdiCalendar(week)},
		Tasks:       tasks,
		Resources:   resources,
		Assignments: assignments,
	}
}

// mspdiRow is one task in the file's order with its outline position.
type mspdiRow struct {
	task    PlanTask
	level   int
	outline string
}

// mspdiOrder lays the tasks out as an outline: a pre-order walk of the Parent
// links (loops cut, as the .gan writer does), then the milestones at the top
// level.
func mspdiOrder(p Plan) []mspdiRow {
	order := ganEncodeOrder(p)
	index := map[string]int{}
	for i, t := range order {
		if _, dup := index[t.Key()]; !dup {
			index[t.Key()] = i
		}
	}
	parent := make([]int, len(order))
	for i, t := range order {
		parent[i] = -1
		if t.Milestone || t.Parent == "" {
			continue
		}
		if j, ok := index[t.Parent]; ok && j != i && !order[j].Milestone {
			parent[i] = j
		}
	}
	ganBreakCycles(parent)
	children := make([][]int, len(order))
	var roots []int
	for i := range order {
		if parent[i] < 0 {
			roots = append(roots, i)
		} else {
			children[parent[i]] = append(children[parent[i]], i)
		}
	}
	var out []mspdiRow
	var walk func(i, level int, outline string)
	walk = func(i, level int, outline string) {
		out = append(out, mspdiRow{task: order[i], level: level, outline: outline})
		for n, c := range children[i] {
			walk(c, level+1, outline+"."+strconv.Itoa(n+1))
		}
	}
	for n, r := range roots {
		walk(r, 1, strconv.Itoa(n+1))
	}
	return out
}

func mspdiCalendar(w Weekend) mspdiCalendarEl {
	cal := mspdiCalendarEl{UID: "1", Name: "Standard", IsBaseCalendar: "1"}
	for d := 0; d < 7; d++ {
		wd := mspdiWeekDayEl{DayType: strconv.Itoa(d + 1), DayWorking: mspdiBool(!w[d])}
		if !w[d] {
			wd.WorkingTimes = []mspdiPeriodEl{{FromTime: "08:00:00", ToTime: "12:00:00"}, {FromTime: "13:00:00", ToTime: "17:00:00"}}
		}
		cal.WeekDays = append(cal.WeekDays, wd)
	}
	return cal
}

// mspdiPeople writes one resource per assignee email, with its capacity as
// MaxUnits (hours per week over 40), and one assignment per task and person.
func mspdiPeople(p Plan, uids map[string]string) ([]mspdiResourceEl, []mspdiAssignEl) {
	capacity := map[string]float64{}
	for _, r := range p.Resources {
		capacity[strings.ToLower(r.Email)] = r.HoursPerWeek
	}
	var resources []mspdiResourceEl
	var assignments []mspdiAssignEl
	byEmail := map[string]string{}
	for _, a := range p.Assignments {
		task, ok := uids[a.Task]
		if !ok {
			continue
		}
		email := strings.ToLower(a.Email)
		res, known := byEmail[email]
		if !known {
			res = strconv.Itoa(len(resources) + 1)
			byEmail[email] = res
			hours, ok := capacity[email]
			if !ok {
				hours = defaultHoursPerWeek
			}
			resources = append(resources, mspdiResourceEl{
				UID: res, ID: res, Name: a.Name, Type: "1", EmailAddress: a.Email,
				MaxUnits: strconv.FormatFloat(hours/defaultHoursPerWeek, 'f', -1, 64),
			})
		}
		assignments = append(assignments, mspdiAssignEl{
			UID: strconv.Itoa(len(assignments) + 1), TaskUID: task, ResourceUID: res, Units: "1",
		})
	}
	return resources, assignments
}

func mspdiStamp(d time.Time, at string) string {
	if d.IsZero() {
		return ""
	}
	return day(d).Format(exchangeDayLayout) + at
}

func mspdiBool(b bool) string {
	if b {
		return "1"
	}
	return "0"
}
