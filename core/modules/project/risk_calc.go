package project

import (
	"math"
	"time"

	"github.com/google/uuid"
)

type calcTask struct {
	ID                  uuid.UUID
	PlannedHours        float64
	DateStart, Deadline *time.Time
	Closed              bool
}

// calcLink: From blocks To.
type calcLink struct{ From, To uuid.UUID }

const hoursPerDay = 8 // PERT convention, same as pert.ts HOURS_PER_DAY

// taskDays mirrors pert.ts taskDuration: hours, else date span, else 1 day.
func taskDays(t calcTask) float64 {
	if t.PlannedHours > 0 {
		return t.PlannedHours / hoursPerDay
	}
	if t.DateStart != nil && t.Deadline != nil {
		if d := t.Deadline.Sub(*t.DateStart).Hours() / 24; d > 0 {
			return d
		}
	}
	return 1
}

// projectFinish is the longest path (Kahn order + forward pass, shared with
// schedule.go), adding extra[id] days to a task's duration. ok is false on a
// cycle. Links to unknown tasks are ignored.
func projectFinish(tasks []calcTask, links []calcLink, extra map[uuid.UUID]float64) (float64, bool) {
	_, _, finish, _, ok := forwardPass(tasks, links, extra)
	return finish, ok
}

func delaySeverity(days float64) int {
	days = math.Round(days*1e6) / 1e6 // float noise: 0.1-day sums must not land a hair under a threshold
	switch {
	case days < 1e-6:
		return 1
	case days < 7:
		return 2
	case days <= 14:
		return 3
	}
	return 4
}

func costSeverity(pct float64) int {
	switch {
	case pct < 1e-6:
		return 1
	case pct < 5:
		return 2
	case pct <= 10:
		return 3
	}
	return 4
}

// riskSeverity computes the severity implied by a risk's linked tasks. note is ""
// when computable; sev is nil for quality or when it cannot be computed.
func riskSeverity(impactOn string, tasks []calcTask, links []calcLink, plannedHours float64, risk []ProjectRiskTask) (sev *int, note string) {
	if impactOn != "delay" && impactOn != "cost" {
		return nil, ""
	}
	closed := map[uuid.UUID]bool{}
	for _, t := range tasks {
		closed[t.ID] = t.Closed
	}
	extra := map[uuid.UUID]float64{}
	var hours float64
	estimated := false
	for _, r := range risk {
		v := r.DelayDays
		if impactOn == "cost" {
			v = r.ExtraHours
		}
		if v == nil {
			continue
		}
		estimated = true
		if closed[r.TaskID] { // work already done: nothing can slip
			continue
		}
		extra[r.TaskID] += *v
		hours += *v
	}
	if impactOn == "cost" && plannedHours <= 0 {
		return nil, "no_planned_hours"
	}
	if !estimated {
		return nil, "no_estimate"
	}
	var s int
	if impactOn == "cost" {
		s = costSeverity(hours / plannedHours * 100)
	} else {
		f0, ok := projectFinish(tasks, links, nil)
		if !ok {
			return nil, "cycle"
		}
		f1, _ := projectFinish(tasks, links, extra)
		s = delaySeverity(f1 - f0)
	}
	return &s, ""
}
