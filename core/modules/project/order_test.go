package project

import (
	"net/http"
	"testing"

	"github.com/google/uuid"
)

func (f *fixture) code(task uuid.UUID) string {
	f.t.Helper()
	return f.str(`SELECT wbs_number FROM project_task WHERE id = $1`, task)
}

func (f *fixture) wantCodes(want map[uuid.UUID]string) {
	f.t.Helper()
	for id, w := range want {
		if got := f.code(id); got != w {
			f.t.Errorf("task %s: order %q, want %q", id, got, w)
		}
	}
}

func TestTaskOrder(t *testing.T) {
	f := newFixture(t)
	m := uuid.New()
	me := f.caller(m)
	p := f.project(m, "everyone")
	a, b, c := f.task(p, nil, nil), f.task(p, nil, nil), f.task(p, nil, nil)
	c1, c2 := f.task(p, &c, nil), f.task(p, &c, nil)
	f.wantCodes(map[uuid.UUID]string{a: "1", b: "2", c: "3", c1: "3.1", c2: "3.2"})

	t.Run("a typed number moves the task and shifts its new siblings", func(t *testing.T) {
		// The answer may carry the pre-renumber number (3.1): the stored one is 2.1.
		if code, body := f.do(me, http.MethodPut, "project_task/"+a.String(), map[string]any{"wbs_number": "3.1"}); code != http.StatusOK {
			t.Fatalf("%d %v", code, body)
		}
		f.wantCodes(map[uuid.UUID]string{b: "1", c: "2", a: "2.1", c1: "2.2", c2: "2.3"})
	})

	t.Run("reorder among the same siblings", func(t *testing.T) {
		if code, body := f.do(me, http.MethodPut, "project_task/"+c2.String(), map[string]any{"wbs_number": "2.1"}); code != http.StatusOK {
			t.Fatalf("%d %v", code, body)
		}
		f.wantCodes(map[uuid.UUID]string{c2: "2.1", a: "2.2", c1: "2.3"})
		if code, _ := f.do(me, http.MethodPut, "project_task/"+c2.String(), map[string]any{"wbs_number": "2.9"}); code != http.StatusOK {
			t.Fatal(code)
		}
		f.wantCodes(map[uuid.UUID]string{a: "2.1", c1: "2.2", c2: "2.3"}) // past the end: last
	})

	t.Run("a re-parent without a number goes last", func(t *testing.T) {
		if code, _ := f.do(me, http.MethodPut, "project_task/"+b.String(), map[string]any{"parent_id": c}); code != http.StatusOK {
			t.Fatal(code)
		}
		f.wantCodes(map[uuid.UUID]string{c: "1", b: "1.4"})
	})

	t.Run("a new task goes last", func(t *testing.T) {
		code, body := f.do(me, http.MethodPost, "project_task", map[string]any{"project_id": p, "name": "N", "parent_id": c})
		if code != http.StatusCreated || body["wbs_number"] != "1.5" {
			t.Fatalf("%d %v, want 201 1.5", code, body)
		}
	})

	t.Run("a deletion closes the gap", func(t *testing.T) {
		if code, _ := f.do(me, http.MethodDelete, "project_task/"+a.String(), nil); code != http.StatusOK && code != http.StatusNoContent {
			t.Fatal(code)
		}
		f.wantCodes(map[uuid.UUID]string{c1: "1.1", c2: "1.2", b: "1.3"})
	})

	t.Run("refused numbers", func(t *testing.T) {
		for _, n := range []string{"0", "1.x", "1..2", "9.1"} {
			if code, _ := f.do(me, http.MethodPut, "project_task/"+b.String(), map[string]any{"wbs_number": n}); code != http.StatusUnprocessableEntity {
				t.Errorf("%q: %d, want 422", n, code)
			}
		}
		// Under itself: the parent cycle check.
		if code, _ := f.do(me, http.MethodPut, "project_task/"+c.String(), map[string]any{"wbs_number": "1.1"}); code != http.StatusUnprocessableEntity {
			t.Errorf("own child: %d, want 422", code)
		}
	})

	t.Run("a moved top-level task goes last in its new project", func(t *testing.T) {
		q := f.project(m, "everyone")
		first := f.task(q, nil, nil)
		if code, body := f.do(me, http.MethodPut, "project_task/"+c.String(), map[string]any{"project_id": q}); code != http.StatusOK {
			t.Fatalf("%d %v", code, body)
		}
		f.wantCodes(map[uuid.UUID]string{first: "1", c: "2", c1: "2.1", b: "2.3"})
	})
}
